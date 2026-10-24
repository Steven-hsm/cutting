'use strict';

const grid = document.getElementById('grid');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const toastEl = document.getElementById('toast');

let entries = [];
let toastTimer = 0;
const filters = { query: '', mode: 'all' };

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatTime(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${Math.max(1, Math.ceil(bytes / 1024))} KB`;
}

function toast(message, isError) {
  toastEl.textContent = message;
  toastEl.classList.toggle('error', !!isError);
  toastEl.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.add('hidden');
    toastTimer = 0;
  }, 2200);
}

async function refresh() {
  try {
    entries = await window.api.history.list();
  } catch (err) {
    entries = [];
  }
  render();
}

function makeButton(label, onClick, extraClass) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (extraClass) button.className = extraClass;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function renderCard(entry) {
  const card = document.createElement('div');
  card.className = 'card';

  const favorite = document.createElement('button');
  favorite.type = 'button';
  favorite.className = `favorite-btn${entry.favorite ? ' active' : ''}`;
  favorite.textContent = entry.favorite ? '★' : '☆';
  favorite.title = entry.favorite ? '取消收藏' : '收藏';
  favorite.addEventListener('click', (event) => {
    event.stopPropagation();
    doFavorite(entry);
  });
  card.appendChild(favorite);

  const thumbWrap = document.createElement('div');
  thumbWrap.className = 'thumb';
  thumbWrap.title = '点击复制到剪贴板';
  if (entry.thumbUrl) {
    const img = document.createElement('img');
    img.src = entry.thumbUrl;
    img.alt = '截图缩略图';
    img.addEventListener('error', () => {
      thumbWrap.textContent = '缩略图缺失';
      thumbWrap.classList.add('missing');
    });
    thumbWrap.appendChild(img);
  } else {
    thumbWrap.textContent = '缩略图缺失';
    thumbWrap.classList.add('missing');
  }
  thumbWrap.addEventListener('click', () => doCopy(entry));

  const meta = document.createElement('div');
  meta.className = 'meta';
  const time = document.createElement('div');
  time.className = 'time';
  time.textContent = formatTime(entry.createdAt);
  const info = document.createElement('div');
  info.className = 'info';
  if (entry.fileExists) {
    const prefix = entry.type === 'gif' ? 'GIF · ' : '';
    info.textContent = `${prefix}${entry.width} × ${entry.height} · ${formatSize(entry.bytes)}`;
  } else {
    info.textContent = '原图已被移动或删除';
    info.classList.add('warn');
  }
  meta.appendChild(time);
  meta.appendChild(info);

  const actions = document.createElement('div');
  actions.className = 'card-actions';
  actions.appendChild(makeButton('复制', () => doCopy(entry)));
  actions.appendChild(makeButton('贴图', () => doPin(entry)));
  if (entry.type !== 'gif') {
    actions.appendChild(makeButton('识图', () => doOcr(entry)));
  }
  actions.appendChild(makeButton('位置', () => doReveal(entry)));
  actions.appendChild(makeButton('删除', () => doRemove(entry), 'danger'));

  card.appendChild(thumbWrap);
  card.appendChild(meta);
  card.appendChild(actions);
  return card;
}

function matches(entry) {
  if (filters.mode === 'favorite' && !entry.favorite) return false;

  const query = filters.query.trim().toLowerCase();
  if (!query) return true;

  const haystack = [
    entry.filePath || '',
    formatTime(entry.createdAt),
    `${entry.width}x${entry.height}`,
    entry.fileExists ? '' : '缺失 missing',
    entry.note || '',
  ]
    .join(' ')
    .toLowerCase();

  return haystack.includes(query);
}

function render() {
  grid.textContent = '';
  const visible = entries.filter(matches);
  count.textContent = entries.length
    ? filters.mode === 'favorite' || filters.query
      ? `${visible.length} / ${entries.length} 条`
      : `${entries.length} 条`
    : '';
  empty.classList.toggle('hidden', visible.length > 0);
  empty.textContent = '';
  if (!visible.length) {
    empty.append(
      entries.length
        ? '没有匹配的记录'
        : '还没有截图记录',
      document.createElement('br')
    );
    const hint = document.createElement('span');
    hint.textContent = entries.length ? '换个关键词或切换筛选试试' : '使用 Ctrl+Alt+A 截取第一张图';
    empty.appendChild(hint);
  }

  const fragment = document.createDocumentFragment();
  for (const entry of visible) {
    fragment.appendChild(renderCard(entry));
  }
  grid.appendChild(fragment);
}

async function doCopy(entry) {
  const result = await window.api.history.copy(entry.id);
  if (result && result.ok) {
    toast(result.kind === 'file' ? '已复制 GIF 文件（可直接粘贴）' : '已复制到剪贴板');
  } else {
    toast((result && result.error) || '复制失败', true);
  }
}

async function doOcr(entry) {
  toast('正在识别文字…');
  const result = await window.api.history.ocr(entry.id);
  if (result && result.ok) toast('识别完成');
  else toast((result && result.error) || '识别失败', true);
}

async function doPin(entry) {
  const result = await window.api.history.pin(entry.id);
  if (result && result.ok) toast('已贴到屏幕顶层');
  else toast((result && result.error) || '贴图失败', true);
}

async function doOcr(entry) {
  toast('正在识别文字…');
  const result = await window.api.history.ocr(entry.id);
  if (result && result.ok) toast('识别完成，结果已在识别窗口中打开');
  else toast((result && result.error) || '识别失败', true);
}

async function doReveal(entry) {
  const result = await window.api.history.reveal(entry.id);
  if (result && !result.ok) toast(result.error || '无法打开位置', true);
}

async function doFavorite(entry) {
  const result = await window.api.history.setFavorite(entry.id, !entry.favorite);
  if (result && result.ok) {
    entry.favorite = result.favorite;
    render();
  } else {
    toast((result && result.error) || '操作失败', true);
  }
}

async function doRemove(entry) {
  if (!window.confirm('删除这条历史记录？（不会删除已保存的原图）')) return;
  const result = await window.api.history.remove(entry.id);
  if (result && !result.ok) toast(result.error || '删除失败', true);
}

document.getElementById('btn-capture').addEventListener('click', () => {
  window.api.app.capture('region');
});

document.getElementById('btn-edit-clipboard').addEventListener('click', async () => {
  const result = await window.api.app.editClipboardImage();
  if (result && !result.ok) toast(result.error || '剪贴板中没有图片', true);
});

// 拖入图片文件进入编辑器
const dropZone = document.getElementById('drop-zone');
let dragDepth = 0;

function isFileDrag(event) {
  const types = event.dataTransfer && event.dataTransfer.types;
  return !!types && Array.prototype.includes.call(types, 'Files');
}

window.addEventListener('dragenter', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth += 1;
  dropZone.classList.remove('hidden');
});

window.addEventListener('dragover', (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', (event) => {
  if (!isFileDrag(event)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) dropZone.classList.add('hidden');
});

window.addEventListener('drop', async (event) => {
  if (!isFileDrag(event)) return;
  event.preventDefault();
  dragDepth = 0;
  dropZone.classList.add('hidden');

  const file = event.dataTransfer.files && event.dataTransfer.files[0];
  if (!file) return;

  const filePath = window.api.files.getPath(file);
  if (!filePath) {
    toast('无法获取文件路径', true);
    return;
  }

  const result = await window.api.app.editImageFile(filePath);
  if (result && !result.ok) toast(result.error || '无法打开该图片', true);
});

document.getElementById('btn-pin-clipboard').addEventListener('click', async () => {
  const result = await window.api.pin.fromClipboard();
  if (result && result.ok) toast('已贴到屏幕顶层');
  else toast((result && result.error) || '剪贴板中没有可贴的内容', true);
});

document.getElementById('btn-open-dir').addEventListener('click', async () => {
  const result = await window.api.app.openSaveDir();
  if (result && !result.ok) toast(result.error || '无法打开目录', true);
});

const searchInput = document.getElementById('search');
const filterAllBtn = document.getElementById('filter-all');
const filterFavoriteBtn = document.getElementById('filter-favorite');

searchInput.addEventListener('input', () => {
  filters.query = searchInput.value;
  render();
});

function setFilter(mode) {
  filters.mode = mode;
  filterAllBtn.classList.toggle('active', mode === 'all');
  filterFavoriteBtn.classList.toggle('active', mode === 'favorite');
  render();
}

filterAllBtn.addEventListener('click', () => setFilter('all'));
filterFavoriteBtn.addEventListener('click', () => setFilter('favorite'));

window.addEventListener('keydown', (event) => {
  if (event.target === searchInput && event.key !== 'Escape') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    if (searchInput.value) {
      searchInput.value = '';
      filters.query = '';
      render();
      return;
    }
    window.api.history.hide();
  } else if (event.key === 'F5') {
    event.preventDefault();
    refresh();
  } else if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'f') {
    event.preventDefault();
    searchInput.focus();
    searchInput.select();
  }
});

window.api.history.onChanged(() => refresh());
refresh();
