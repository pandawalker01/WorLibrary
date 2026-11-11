import { expect, test, type Page } from '@playwright/test'

test.use({ serviceWorkers: 'block' })
const configured = Boolean(process.env.VITE_SUPABASE_URL && process.env.VITE_SUPABASE_ANON_KEY)
const owner = '11111111-1111-4111-8111-111111111111'
const other = '22222222-2222-4222-8222-222222222222'
const initial = { enabled: false, consented: false, quotaBytes: 1073741824, usedBytes: 0, reservedBytes: 0 }
async function signIn(page: Page, anonymous = false, locale = 'zh-CN') {
  await page.addInitScript(({ owner, anonymous, locale }) => {
    localStorage.setItem('wor-library.auth.session', JSON.stringify({ accessToken: 'synthetic-owner', refreshToken: 'synthetic-refresh', user: { id: owner, isAnonymous: anonymous } }))
    localStorage.setItem('worlibrary.ui-locale', locale)
  }, { owner, anonymous, locale })
}

test('anonymous settings never expose private file consent or send a consent write', async ({ page }) => {
  await signIn(page, true)
  let calls = 0
  await page.route('**/rest/v1/rpc/**', route => { if (route.request().url().includes('private_file_library')) calls++; return route.fulfill({ status: 400, json: {} }) })
  await page.goto('/?view=settings')
  await expect(page.getByRole('heading', { name: '账户中心' })).toBeVisible()
  await expect(page.getByTestId('private-cloud-preferences')).toHaveCount(0)
  expect(calls).toBe(0)
})

test.describe('configured private cloud permission UI', () => {
  test.skip(!configured, 'Build and run with the CI public VITE Supabase fixture configuration; no real account is used')

  test('first consent requires an unchecked agreement; pause and resume are explicit boolean-only writes', async ({ page }) => {
    await signIn(page)
    let state = { ...initial }; const writes: unknown[] = []; let fileWrites = 0
    await page.route('**/api/user-files/**', route => { if (route.request().method() === 'POST') fileWrites++; return route.fulfill({ status: 503, json: {} }) })
    await page.route('**/rest/v1/rpc/**', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1)
      if (name === 'get_private_file_library_state') return route.fulfill({ json: state })
      if (name === 'set_private_file_library_enabled') {
        const body = route.request().postDataJSON(); writes.push(body)
        state = { ...state, enabled: body.p_enabled, consented: true }
        return route.fulfill({ json: state })
      }
      return route.fulfill({ status: 400, json: {} })
    })
    await page.goto('/?view=settings')
    const card = page.getByTestId('private-cloud-preferences')
    await card.getByRole('button', { name: '开启原书上传' }).click()
    const dialog = page.getByRole('dialog', { name: '允许上传以后导入的原书？' })
    const agree = dialog.getByRole('checkbox')
    await expect(agree).not.toBeChecked(); await expect(agree).toBeFocused()
    await expect(dialog.getByRole('button', { name: '同意并开启' })).toBeDisabled()
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden(); expect(writes).toEqual([])
    await card.getByRole('button', { name: '开启原书上传' }).click()
    await agree.check(); await dialog.getByRole('button', { name: '同意并开启' }).click()
    await expect(card.getByText('已允许上传原书', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: '暂停原书上传' }).click()
    await expect(card.getByText('原书上传已暂停', { exact: true })).toBeVisible()
    await card.getByRole('button', { name: '恢复原书上传' }).click()
    await expect(card.getByText('已允许上传原书', { exact: true })).toBeVisible()
    expect(writes).toEqual([{ p_enabled: true }, { p_enabled: false }, { p_enabled: true }]); expect(fileWrites).toBe(0)
  })

  test('unknown state and an ambiguous consent response fail closed until an explicit reload', async ({ page }) => {
    await signIn(page)
    let validRead = false; let writes = 0
    await page.route('**/rest/v1/rpc/**', async route => {
      const name = new URL(route.request().url()).pathname.split('/').at(-1)
      if (name === 'get_private_file_library_state') return route.fulfill({ json: validRead ? { ...initial, enabled: writes > 0, consented: writes > 0 } : { ...initial, object_key: 'must-not-render' } })
      if (name === 'set_private_file_library_enabled') { writes++; return route.fulfill({ status: 500, json: {} }) }
      return route.fulfill({ status: 400, json: {} })
    })
    await page.goto('/?view=settings')
    const card = page.getByTestId('private-cloud-preferences')
    await expect(card.getByText('暂时无法读取云书库状态，请重试。')).toBeVisible()
    await expect(card).not.toContainText('must-not-render'); expect(writes).toBe(0)
    validRead = true; await card.getByRole('button', { name: '重试' }).click()
    await card.getByRole('button', { name: '开启原书上传' }).click()
    const dialog = page.getByRole('dialog', { name: '允许上传以后导入的原书？' })
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '同意并开启' }).click()
    await expect(dialog.getByRole('alert')).toHaveText('授权状态未能确认，请重新读取后重试。')
    await expect(dialog.getByRole('button', { name: '同意并开启' })).toHaveCount(0)
    await dialog.getByRole('button', { name: '重新读取状态' }).click()
    await expect(card.getByText('已允许上传原书', { exact: true })).toBeVisible(); expect(writes).toBe(1)
  })

  test('account switching discards a pending consent response and never displays old account usage', async ({ page }) => {
    await signIn(page)
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve }); const writeOwners: string[] = []
    await page.route('**/rest/v1/rpc/**', async route => {
      const request = route.request(); const name = new URL(request.url()).pathname.split('/').at(-1)
      const isOther = request.headers().authorization?.includes('synthetic-other')
      if (name === 'get_private_file_library_state') return route.fulfill({ json: { ...initial, usedBytes: isOther ? 7 * 1048576 : 999 * 1048576 } })
      if (name === 'set_private_file_library_enabled') {
        writeOwners.push(request.headers().authorization ?? ''); await pending
        return route.fulfill({ json: { ...initial, enabled: true, consented: true, usedBytes: 999 * 1048576 } }).catch(() => {})
      }
      return route.fulfill({ status: 400, json: {} })
    })
    await page.goto('/?view=settings')
    const card = page.getByTestId('private-cloud-preferences')
    await card.getByRole('button', { name: '开启原书上传' }).click()
    const dialog = page.getByRole('dialog', { name: '允许上传以后导入的原书？' })
    await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: '同意并开启' }).click()
    await expect.poll(() => writeOwners.length).toBe(1)
    await page.evaluate(other => {
      localStorage.setItem('wor-library.auth.session', JSON.stringify({ accessToken: 'synthetic-other', refreshToken: 'synthetic-refresh', user: { id: other, isAnonymous: false } }))
      window.dispatchEvent(new StorageEvent('storage', { key: 'wor-library.auth.session' }))
    }, other)
    await expect(card).toContainText('7 MB'); release()
    await expect(card).not.toContainText('999 MB'); await expect(dialog).toBeHidden()
    await expect(card.getByText('尚未开启原书上传', { exact: true })).toBeVisible()
    expect(writeOwners).toEqual(['Bearer synthetic-owner'])
  })

  test('English permission UI preserves the same explicit agreement boundary', async ({ page }) => {
    await signIn(page, false, 'en')
    await page.route('**/rest/v1/rpc/**', route => route.fulfill({ status: route.request().url().endsWith('/get_private_file_library_state') ? 200 : 400, json: initial }))
    await page.goto('/?view=settings')
    const card = page.getByTestId('private-cloud-preferences')
    await expect(card.getByRole('heading', { name: 'Private cloud library' })).toBeVisible()
    await card.getByRole('button', { name: 'Enable original file uploads' }).click()
    const dialog = page.getByRole('dialog', { name: 'Allow uploads of future imports?' })
    await expect(dialog.getByRole('checkbox')).not.toBeChecked()
    await expect(dialog.getByRole('button', { name: 'Agree and enable' })).toBeDisabled()
  })
})
