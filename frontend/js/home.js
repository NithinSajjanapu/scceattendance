const form = document.querySelector('#attendance-form');
const input = document.querySelector('#hall-ticket');
const submitButton = document.querySelector('#submit-button');
const errorNode = document.querySelector('#form-error');
const validTicket = (value) => /^[A-Z0-9][A-Z0-9-]{5,24}$/.test(value);
const forgotButton = document.querySelector('#forgot-ticket-button');
const forgotForm = document.querySelector('#forgot-ticket-form');
const forgotName = document.querySelector('#forgot-name');
const forgotError = document.querySelector('#forgot-error');
const forgotResults = document.querySelector('#forgot-results');

function updateInput() {
  input.value = input.value.trim().toUpperCase();
  submitButton.disabled = !validTicket(input.value);
  errorNode.textContent = '';
}

input.addEventListener('input', updateInput);

form.addEventListener('submit', (event) => {
  event.preventDefault();
  updateInput();

  if (!validTicket(input.value)) {
    errorNode.textContent = 'Please enter a valid Hall Ticket Number.';
    input.focus();
    return;
  }

  // The default Overall Attendance view is in maintenance mode, so entering
  // the dashboard must not request the unavailable overview first.
  sessionStorage.removeItem('attendance-result');
  sessionStorage.setItem('attendance-ticket', input.value);
  location.href = 'attendance.html';
});

forgotButton.addEventListener('click', () => { forgotForm.hidden = !forgotForm.hidden; if (!forgotForm.hidden) forgotName.focus(); });
document.querySelector('#forgot-search-button').addEventListener('click', async () => {
  const name = forgotName.value.trim();
  forgotError.textContent = ''; forgotResults.innerHTML = '';
  if (!/^[A-Za-z ]{4,80}$/.test(name)) { forgotError.textContent = 'Enter at least four letters from your name.'; return; }
  try {
    const data = await window.portalApi('forgot-hall-ticket', { name });
    forgotResults.innerHTML = data.matches.map((match) => `<button type="button" class="forgot-match" data-ticket="${match.hallTicket}"><strong>${match.hallTicket}</strong><span>${match.name}${match.branch ? ` · ${match.branch}` : ''}</span></button>`).join('');
    forgotResults.querySelectorAll('[data-ticket]').forEach((button) => button.addEventListener('click', () => { input.value = button.dataset.ticket; updateInput(); forgotForm.hidden = true; input.focus(); }));
  } catch (error) { forgotError.textContent = error.message; }
});
