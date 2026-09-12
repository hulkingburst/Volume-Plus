/*
 * Volume+ — background service worker (minimal).
 *
 * The audio engine runs entirely in content scripts, so this worker has no
 * logic of its own. It exists to satisfy the extension lifecycle and to keep
 * a discoverable extension context for messaging/tests.
 */
chrome.runtime.onInstalled.addListener(() => {
  // Intentionally empty.
});