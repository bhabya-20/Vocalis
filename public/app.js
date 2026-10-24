const API = '/api/transcriptions';
const AUTH_API = '/api/auth';
let items = [];
let authUser = null;
let loadState = 'loading';
let editingId = null;
let recognition = null;
let isRecording = false;
let finalText = '';
let deleteId = null;
let toastTimer;
let authMode = 'signin';
let resumeAfterAuth = false;

const $ = selector => document.querySelector(selector);
const textarea = $('#transcript');
const iconDoc = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8"/></svg>';
const iconEdit = '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>';
const iconDelete = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2m3 0-1 14H6L5 6m4 4v6m6-6v6"/></svg>';

const esc = value => String(value).replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[character]));

function notify(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3000);
}

function updateWords() {
  const words = textarea.value.trim();
  $('#wordCount').textContent = words ? words.split(/\s+/u).length : 0;
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(value));
}

function initDate() {
  const now = new Date();
  $('#dateLabel').textContent = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(now);
  $('#todayDate').textContent = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' }).format(now);
}

function updateAccountUi() {
  const signedIn = Boolean(authUser);
  $('#authButton').hidden = signedIn;
  $('#logoutButton').hidden = !signedIn;
  $('#accountLabel').hidden = !signedIn;
  $('#accountLabel').textContent = signedIn ? authUser.email : '';
  $('.avatar').textContent = signedIn ? authUser.email.charAt(0).toUpperCase() : '?';
  $('.profile b').textContent = signedIn ? 'Personal workspace' : 'Guest workspace';
  $('.profile small').textContent = signedIn ? 'Signed in' : 'Sign in to save';
}

async function load() {
  loadState = 'loading';
  render();
  try {
    const accountResponse = await fetch(AUTH_API + '/me');
    if (accountResponse.status === 401) {
      authUser = null;
      items = [];
      loadState = 'guest';
      $('#serviceStatusText').textContent = 'Sign in to save';
      $('#serviceStatus').classList.remove('error');
      updateAccountUi();
      render();
      return;
    }
    if (!accountResponse.ok) throw new Error();
    const account = await accountResponse.json();
    authUser = account.user;
    updateAccountUi();
    const response = await fetch(API);
    if (!response.ok) throw new Error();
    items = await response.json();
    loadState = 'ready';
    $('#serviceStatusText').textContent = 'Database connected';
    $('#serviceStatus').classList.remove('error');
    render();
  } catch {
    loadState = 'error';
    $('#serviceStatusText').textContent = 'Connection issue';
    $('#serviceStatus').classList.add('error');
    render();
  }
}

function render() {
  const query = $('#search').value.trim().toLowerCase();
  const shown = items.filter(item => (item.title + ' ' + item.content + ' ' + item.language).toLowerCase().includes(query));
  $('#navCount').textContent = items.length;
  $('#countLabel').textContent = query
    ? shown.length + ' of ' + items.length + ' recordings'
    : items.length + ' recording' + (items.length === 1 ? '' : 's');

  const list = $('#historyList');
  if (loadState === 'loading') {
    list.innerHTML = '<div class="history-loading">Loading your transcriptions...</div>';
  } else if (loadState === 'error') {
    list.innerHTML = '<div class="empty"><strong>Could not load your history.</strong><br>Check that the app server and database are running.<br><button class="btn" id="retryBtn" style="margin:14px auto 0">Try again</button></div>';
    $('#retryBtn').onclick = load;
  } else if (loadState === 'guest') {
    list.innerHTML = '<div class="empty"><strong>Your history is for your account.</strong><br>Create an account or sign in to save and view your transcriptions.<br><button class="btn primary" id="historySignIn" style="margin:14px auto 0">Sign in or create account</button></div>';
    $('#historySignIn').onclick = () => openAuth('signup');
  } else if (!shown.length) {
    list.innerHTML = '<div class="empty">' + (query ? 'No transcriptions match your search.' : 'No transcriptions yet. Start speaking or type a note, then save it here.') + '</div>';
  } else {
    list.innerHTML = shown.map(item => '<article class="history-item"><div class="doc-icon">' + iconDoc + '</div><div class="item-info"><h3>' + esc(item.title) + '</h3><p>' + esc(item.content) + '</p></div><div class="meta"><span class="tag">' + esc(langLabel(item.language)) + '</span><span>' + formatDate(item.updatedAt) + '</span></div><div class="item-actions"><button class="icon-btn" aria-label="Edit ' + esc(item.title) + '" title="Edit" data-edit="' + item.id + '">' + iconEdit + '</button><button class="icon-btn delete" aria-label="Delete ' + esc(item.title) + '" title="Delete" data-delete="' + item.id + '">' + iconDelete + '</button></div></article>').join('');
    list.querySelectorAll('[data-edit]').forEach(button => button.onclick = () => editItem(button.dataset.edit));
    list.querySelectorAll('[data-delete]').forEach(button => button.onclick = () => askDelete(button.dataset.delete));
  }
}

function langLabel(code) {
  return ({ 'en-IN': 'English (India)', 'hi-IN': 'Hindi (India)', 'en-US': 'English (US)', 'en-GB': 'English (UK)' })[code] || code;
}

function openAuth(mode = 'signin') {
  authMode = mode;
  const signingUp = mode === 'signup';
  $('#authTitle').textContent = signingUp ? 'Create your account' : 'Sign in to Vocalis';
  $('#authDescription').textContent = signingUp ? 'Create an account to save and access your transcriptions.' : 'Sign in to save and access your transcriptions.';
  $('#authSubmit').textContent = signingUp ? 'Create account' : 'Sign in';
  $('#confirmPasswordWrap').hidden = !signingUp;
  $('#confirmPassword').required = signingUp;
  $('#authPassword').autocomplete = signingUp ? 'new-password' : 'current-password';
  $('#signinTab').classList.toggle('active', !signingUp);
  $('#signupTab').classList.toggle('active', signingUp);
  $('#authError').textContent = '';
  $('#authModal').classList.add('open');
  $('#authEmail').focus();
}

function closeAuth() {
  resumeAfterAuth = false;
  $('#authModal').classList.remove('open');
  $('#authForm').reset();
  $('#authError').textContent = '';
}

async function submitAuth(event) {
  event.preventDefault();
  const email = $('#authEmail').value.trim();
  const password = $('#authPassword').value;
  const signingUp = authMode === 'signup';
  if (signingUp && password !== $('#confirmPassword').value) {
    $('#authError').textContent = 'Those passwords do not match.';
    return;
  }
  const submitButton = $('#authSubmit');
  submitButton.disabled = true;
  submitButton.textContent = signingUp ? 'Creating account...' : 'Signing in...';
  $('#authError').textContent = '';
  try {
    const response = await fetch(AUTH_API + (signingUp ? '/signup' : '/signin'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not sign in. Please try again.');
    authUser = result.user;
    const continueSave = resumeAfterAuth;
    resumeAfterAuth = false;
    closeAuth();
    updateAccountUi();
    notify(signingUp ? 'Account created. You are signed in.' : 'Welcome back. You are signed in.');
    await load();
    if (continueSave) await save();
  } catch (error) {
    $('#authError').textContent = error instanceof TypeError ? 'Could not reach the server. Check your connection and try again.' : error.message;
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = authMode === 'signup' ? 'Create account' : 'Sign in';
  }
}

async function signOut() {
  try {
    const response = await fetch(AUTH_API + '/logout', { method: 'POST' });
    if (!response.ok) throw new Error();
    authUser = null;
    items = [];
    updateAccountUi();
    notify('You have signed out. Your draft is still here.');
    await load();
  } catch {
    notify('Could not sign out. Check your connection and try again.');
  }
}

function setupRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    notify('Live speech recognition needs a supported browser such as Chrome. You can still type and save.');
    return null;
  }
  const instance = new SpeechRecognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.maxAlternatives = 1;
  instance.lang = $('#language').value;
  instance.onstart = () => {
    isRecording = true;
    $('#recordBtn').classList.add('stop');
    $('#recordBtn').innerHTML = '<svg viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span>Stop listening</span>';
    $('#liveStatus').classList.add('recording');
    $('#liveStatus').innerHTML = '<i></i><span>Listening now...</span>';
    $('#language').disabled = true;
  };
  instance.onresult = event => {
    let interim = '';
    for (let index = event.resultIndex; index < event.results.length; index++) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) finalText += text + ' ';
      else interim += text;
    }
    textarea.value = (finalText + interim).trimStart();
    $('#interimText').textContent = interim ? 'Hearing: ' + interim : '';
    updateWords();
  };
  instance.onerror = event => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      notify('Microphone access is blocked. Allow it in your browser settings, then try again.');
      stopRecording();
    } else if (event.error === 'audio-capture') {
      notify('No microphone was found. Connect a microphone and try again.');
      stopRecording();
    } else if (event.error !== 'no-speech' && event.error !== 'aborted') {
      notify('Speech recognition had a problem. Check your connection and try again.');
    }
  };
  instance.onend = () => {
    if (isRecording) {
      try { instance.start(); } catch { stopRecording(); }
    }
  };
  return instance;
}

function startRecording() {
  if (isRecording) { stopRecording(); return; }
  finalText = textarea.value ? textarea.value.trimEnd() + ' ' : '';
  recognition = setupRecognition();
  if (!recognition) return;
  try { recognition.start(); }
  catch { stopRecording(); notify('Could not start listening. Please try again.'); }
}

function stopRecording() {
  isRecording = false;
  if (recognition) {
    const current = recognition;
    recognition = null;
    try { current.stop(); } catch { /* recognition may already have stopped */ }
  }
  $('#recordBtn').classList.remove('stop');
  $('#recordBtn').innerHTML = '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg><span>Start speaking</span>';
  $('#liveStatus').classList.remove('recording');
  $('#liveStatus').innerHTML = '<i></i><span>Ready when you are</span>';
  $('#language').disabled = false;
  $('#interimText').textContent = '';
}

function resetDraft() {
  stopRecording();
  textarea.value = '';
  $('#transcriptionTitle').value = '';
  finalText = '';
  editingId = null;
  $('#saveBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l6 6v10a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/></svg>Save transcription';
  updateWords();
}

function editItem(id) {
  const item = items.find(value => String(value.id) === String(id));
  if (!item) return;
  resetDraft();
  editingId = item.id;
  $('#transcriptionTitle').value = item.title;
  textarea.value = item.content;
  $('#language').value = item.language;
  $('#saveBtn').innerHTML = '<svg viewBox="0 0 24 24"><path d="m5 12 5 5L20 7"/></svg>Update transcription';
  updateWords();
  $('#recorder').scrollIntoView({ behavior: 'smooth', block: 'center' });
  $('#transcriptionTitle').focus();
}

async function save() {
  const content = textarea.value.trim();
  if (!content) { notify('Type or record a few words before saving.'); textarea.focus(); return; }
  if (!authUser) {
    resumeAfterAuth = true;
    openAuth('signup');
    return;
  }
  const automaticTitle = content.split(/[.!?\n]/)[0].trim().slice(0, 64) || 'Untitled transcription';
  const payload = { title: $('#transcriptionTitle').value.trim() || automaticTitle, content, language: $('#language').value };
  const wasEditing = Boolean(editingId);
  const button = $('#saveBtn');
  const originalLabel = button.lastChild.textContent;
  let saved = false;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.lastChild.textContent = 'Saving...';
  try {
    const response = await fetch(wasEditing ? API + '/' + editingId : API, {
      method: wasEditing ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    });
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      if (response.status === 401) {
        authUser = null;
        resumeAfterAuth = true;
        updateAccountUi();
        openAuth('signin');
      }
      throw new Error(result.error || 'Save failed. Check your connection and try again.');
    }
    notify(wasEditing ? 'Transcription updated' : 'Transcription saved');
    resetDraft();
    saved = true;
    await load();
  } catch (error) {
    notify(error instanceof TypeError ? 'Could not reach the server. Check your connection and try again.' : error.message);
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (!saved) button.lastChild.textContent = originalLabel;
  }
}

function askDelete(id) {
  deleteId = id;
  $('#deleteModal').classList.add('open');
  $('#cancelDelete').focus();
}

async function deleteItem() {
  if (!deleteId) return;
  try {
    const response = await fetch(API + '/' + deleteId, { method: 'DELETE' });
    if (!response.ok) throw new Error();
    items = items.filter(item => String(item.id) !== String(deleteId));
    render();
    if (String(editingId) === String(deleteId)) resetDraft();
    notify('Transcription deleted');
  } catch {
    notify('Could not delete this transcription. Check your connection and try again.');
  } finally {
    $('#deleteModal').classList.remove('open');
    deleteId = null;
  }
}

$('#recordBtn').onclick = startRecording;
$('#clearBtn').onclick = () => { resetDraft(); textarea.focus(); };
$('#saveBtn').onclick = save;
$('#search').oninput = render;
textarea.oninput = () => { finalText = textarea.value; updateWords(); };
$('#authButton').onclick = () => openAuth('signin');
$('#logoutButton').onclick = signOut;
$('#signinTab').onclick = () => openAuth('signin');
$('#signupTab').onclick = () => openAuth('signup');
$('#closeAuth').onclick = closeAuth;
$('#authForm').addEventListener('submit', submitAuth);
$('#authModal').onclick = event => { if (event.target.id === 'authModal') closeAuth(); };
$('#cancelDelete').onclick = () => $('#deleteModal').classList.remove('open');
$('#confirmDelete').onclick = deleteItem;
$('#deleteModal').onclick = event => { if (event.target.id === 'deleteModal') $('#deleteModal').classList.remove('open'); };
$('#historyNav').onclick = () => $('#historyList').scrollIntoView({ behavior: 'smooth' });
$('#mobileHistory').onclick = () => $('#historyList').scrollIntoView({ behavior: 'smooth' });
document.addEventListener('keydown', event => {
  if (event.code === 'Space' && event.target === document.body) { event.preventDefault(); startRecording(); }
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') save();
  if (event.key === 'Escape') { closeAuth(); $('#deleteModal').classList.remove('open'); }
});

initDate();
updateWords();
load();
