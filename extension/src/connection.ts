import { getSettings, type ExtensionSettings } from './shared.js';

interface Account {
  id: number;
  name: string;
}

const form = document.querySelector<HTMLFormElement>('#connection-form')!;
const status = document.querySelector<HTMLElement>('#connection-status')!;
const accounts = document.querySelector<HTMLElement>('#accounts')!;

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function request(settings: ExtensionSettings, path: string, body: unknown): Promise<Response> {
  return fetch(`${settings.bridgeUrl.replace(/\/$/, '')}${path}`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-extension-token': settings.extensionToken,
    },
    body: JSON.stringify(body),
  });
}

function renderAccounts(settings: ExtensionSettings, availableAccounts: Account[]): void {
  accounts.replaceChildren(...availableAccounts.map((account) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = `Use ${account.name}`;
    button.addEventListener('click', async () => {
      const response = await request(settings, '/api/tradovate/account', { accountId: account.id });
      if (!response.ok) {
        setStatus('Could not select the Tradovate account.', true);
        return;
      }
      setStatus(`${account.name} is ready for demo order review.`);
      accounts.replaceChildren();
    });
    return button;
  }));
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const settings = await getSettings();
  if (!settings) {
    setStatus('Save the bridge connection in the extension popup first.', true);
    return;
  }
  const submit = form.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  submit.disabled = true;
  try {
    const response = await request(settings, '/api/tradovate/connection', {
      environment: 'demo',
      username: document.querySelector<HTMLInputElement>('#username')!.value,
      password: document.querySelector<HTMLInputElement>('#password')!.value,
      cid: document.querySelector<HTMLInputElement>('#cid')!.value,
      sec: document.querySelector<HTMLInputElement>('#sec')!.value,
    });
    if (!response.ok) throw new Error('Tradovate demo authentication failed.');
    const body = await response.json() as { accounts: Account[] };
    form.reset();
    setStatus('Connected. Select the account to use for demo orders.');
    renderAccounts(settings, body.accounts);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not connect to Tradovate.', true);
  } finally {
    submit.disabled = false;
  }
});
