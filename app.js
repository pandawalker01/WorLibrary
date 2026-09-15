const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const views = { library: $('#libraryView'), settings: $('#settingsView') };
const toast = $('#toast');

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => toast.classList.remove('show'), 2800);
}

function setView(name) {
  $$('.view').forEach((view) => view.classList.remove('active'));
  views[name].classList.add('active');
  $$('.nav-item').forEach((button) => button.classList.toggle('active', button.dataset.view === name));
}

$$('.nav-item').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));
$$('.book-card[data-book]').forEach((card) => card.addEventListener('click', () => {
  $$('.view').forEach((view) => view.classList.remove('active'));
  $('#readerView').classList.add('active');
}));
$('#backButton').addEventListener('click', () => setView('library'));

function openImport() { $('#fileInput').click(); }
$('#importButton').addEventListener('click', openImport);
$('#importCard').addEventListener('click', openImport);
$('#fileInput').addEventListener('change', (event) => {
  const count = event.target.files.length;
  if (count) showToast(`已加入 ${count} 本书 · Demo 中不会上传文件`);
  event.target.value = '';
});

$('#explainButton').addEventListener('click', () => $('#aiPanel').classList.remove('hidden'));
$('#closeAi').addEventListener('click', () => $('#aiPanel').classList.add('hidden'));
$('#selectableText').addEventListener('mouseup', () => showToast('已选择文字 · 点击“用 AI 解释”查看示例'));

$('#compareButton').addEventListener('click', () => {
  const stage = $('#readingStage');
  stage.classList.toggle('comparing');
  $('#translationPage').classList.toggle('hidden', !stage.classList.contains('comparing'));
  $('#compareButton').innerHTML = stage.classList.contains('comparing') ? '↹ <span>退出对照</span>' : '⇄ <span>对照阅读</span>';
});

$$('.edition').forEach((edition) => edition.addEventListener('click', () => {
  $$('.edition').forEach((item) => item.classList.remove('active'));
  edition.classList.add('active');
  showToast(`已切换到${edition.dataset.edition}版本 · 阅读进度独立保存`);
}));

$('#ocrButton').addEventListener('click', () => showToast('OCR 是下一步真实服务接入点：当前为演示提示'));
$$('.language-choice').forEach((choice) => choice.addEventListener('click', () => {
  $$('.language-choice').forEach((item) => item.classList.remove('active'));
  choice.classList.add('active');
  const label = choice.firstChild.textContent.trim();
  $('#languageButton').innerHTML = `理解语言：<strong>${label}</strong>⌄`;
  showToast(`已将 AI 理解语言设为：${label}`);
}));
$('#languageButton').addEventListener('click', () => setView('settings'));
$('#readerLanguage').addEventListener('click', () => setView('settings'));
$$('.filter').forEach((filter) => filter.addEventListener('click', () => {
  $$('.filter').forEach((item) => item.classList.remove('active'));
  filter.classList.add('active');
  showToast('Demo 已更新筛选状态');
}));
