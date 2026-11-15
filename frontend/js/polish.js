// Tap an encrypted bubble to show or hide its full emoji code.
document.addEventListener('click', e => {
  const el = e.target.closest && e.target.closest('.msg-content.is-cipher');
  if (el && !e.target.closest('button, a')) el.classList.toggle('open');
});
