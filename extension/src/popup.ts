import { DEFAULT_BRIDGE_URL, getSettings, SETTINGS_KEY, type ExtensionSettings, type OverlayPosition } from './shared.js';

const form = document.querySelector<HTMLFormElement>('#settings-form')!;
const bridgeUrl = document.querySelector<HTMLInputElement>('#bridge-url')!;
const extensionToken = document.querySelector<HTMLInputElement>('#extension-token')!;
const overlayPosition = document.querySelector<HTMLSelectElement>('#overlay-position')!;
const status = document.querySelector<HTMLElement>('#connection-status')!;
const openReview = document.querySelector<HTMLButtonElement>('#open-review')!;

function setStatus(message: string, isError = false): void {
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function requestBridgePermission(url: string): Promise<string> {
  const origin = new URL(url).origin;
  const parsedUrl = new URL(origin);
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    throw new Error('Bridge URL must use HTTP or HTTPS.');
  }
  const granted = await chrome.permissions.request({
    origins: [`${parsedUrl.protocol}//${parsedUrl.hostname}/*`],
  });
  if (!granted) throw new Error('Bridge access permission was not granted.');
  return origin;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const settings: ExtensionSettings = {
      bridgeUrl: await requestBridgePermission(bridgeUrl.value.trim()),
      extensionToken: extensionToken.value.trim(),
      overlayPosition: overlayPosition.value as OverlayPosition,
    };
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    chrome.runtime.sendMessage({ type: 'poll-now' });
    setStatus('Connection saved. Open order review to see drafts.');
  } catch (error) {
    setStatus(error instanceof Error ? error.message : 'Could not save bridge settings.', true);
  }
});

openReview.addEventListener('click', () => {
  void chrome.tabs.create({ url: chrome.runtime.getURL('review.html') });
});

void (async () => {
  const settings = await getSettings();
  bridgeUrl.value = settings?.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  if (settings) {
    extensionToken.value = settings.extensionToken;
    overlayPosition.value = settings.overlayPosition ?? 'bottom-right';
  }
  if (!settings) setStatus('Save your bridge URL and extension token to connect.');
})();
