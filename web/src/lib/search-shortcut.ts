export function registerSearchShortcut(input: HTMLInputElement): () => void {
  const document = input.ownerDocument;
  const isMac = /Mac/i.test(document.defaultView?.navigator.platform ?? "");
  const keydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      event.isComposing ||
      event.key.toLowerCase() !== "k" ||
      event.altKey ||
      event.shiftKey ||
      (isMac
        ? !event.metaKey || event.ctrlKey
        : !event.ctrlKey || event.metaKey)
    ) {
      return;
    }

    event.preventDefault();
    input.focus();
    input.select();
  };

  document.addEventListener("keydown", keydown);
  return () => document.removeEventListener("keydown", keydown);
}
