import type { UiLocale } from './i18n'

// Loaded only with the private-cloud settings subtree, alongside its UI.
const zh = {
  title: '私有云书库', loading: '正在读取上传授权…', unavailable: '暂时无法读取云书库状态，请重试。', retry: '重试',
  enabled: '已允许上传原书', paused: '原书上传已暂停', disabled: '尚未开启原书上传',
  scope: '授权仅用于本人私有云书库；这台设备以前保存的书不会因此自动上传。',
  enable: '开启原书上传', resume: '恢复原书上传', pause: '暂停原书上传', saving: '正在保存…',
  pausedCopy: '暂停不删除已有云端原书，也不影响本人读取。',
  consentTitle: '允许上传以后导入的原书？',
  consentCopy: '开启后允许将以后导入的 EPUB/PDF 原书上传至本人私有云书库。原书只供本人访问，使用私有对象存储，不提供端到端加密。',
  agree: '我同意上传以后导入的 EPUB/PDF 原书。', confirm: '同意并开启', cancel: '暂不开启', close: '关闭', reload: '重新读取状态',
  usage: '正文用量', reserved: '待处理用量', saveFailed: '授权状态未能确认，请重新读取后重试。',
  deletionTitle: '云端正文删除', deletionLoading: '正在读取删除任务…', deletionUnavailable: '部分删除任务暂时无法读取，请重试。', deletionEmpty: '暂无待重试的删除请求。',
  reloadDeletions: '重新读取删除任务', retryDelete: '重试删除', deletePending: '正文清理尚待确认，可继续重试。', deleteFailed: '删除尚未确认，请重试。', deleteDone: '删除请求已处理。', deleting: '正在处理…',
}
const en: typeof zh = {
  title: 'Private cloud library', loading: 'Loading upload permission…', unavailable: 'Cloud library status is unavailable. Please retry.', retry: 'Retry',
  enabled: 'Original file uploads allowed', paused: 'Original file uploads paused', disabled: 'Original file uploads are off',
  scope: 'Permission is for your private library. Books already saved on this device are not uploaded automatically.',
  enable: 'Enable original file uploads', resume: 'Resume original file uploads', pause: 'Pause original file uploads', saving: 'Saving…',
  pausedCopy: 'Pausing keeps existing cloud files available to you.',
  consentTitle: 'Allow uploads of future imports?',
  consentCopy: 'Allow future EPUB/PDF imports to be uploaded to your private cloud library. Only you can access them. Storage is private, without end-to-end encryption.',
  agree: 'I agree to upload EPUB/PDF files imported in the future.', confirm: 'Agree and enable', cancel: 'Not now', close: 'Close', reload: 'Reload status',
  usage: 'File storage used', reserved: 'Pending storage', saveFailed: 'Permission could not be confirmed. Reload the status and retry.',
  deletionTitle: 'Cloud file deletion', deletionLoading: 'Loading deletion requests…', deletionUnavailable: 'Some deletion requests could not be loaded. Please retry.', deletionEmpty: 'No deletion requests need a retry.',
  reloadDeletions: 'Reload deletion requests', retryDelete: 'Retry deletion', deletePending: 'File cleanup is pending. You can retry.', deleteFailed: 'Deletion is not confirmed. Please retry.', deleteDone: 'Deletion request processed.', deleting: 'Processing…',
}
export const privateCloudCopy = (locale: UiLocale) => locale === 'en' ? en : zh
