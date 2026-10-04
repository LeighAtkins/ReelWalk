/**
 * Copies text. The Clipboard API only exists on HTTPS and localhost, so on a
 * phone opening the app over the local network the older selection-based
 * copy is used instead.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied: fall through to the older method.
    }
  }
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.appendChild(field);
  field.select();
  field.setSelectionRange(0, text.length);
  const copied = document.execCommand("copy");
  field.remove();
  return copied;
}
