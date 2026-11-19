/**
 * The server filter for what a cashier typed into the customer lookup: a phone number, an e-mail, or a name. The server does the matching (and the tenant /
 * company scoping); this only picks WHICH filter to send.
 */
export function customerQuery(text: string): {
  displayName?: string;
  phone?: string;
  email?: string;
} {
  const term = text.trim();
  if (term === '') return {};
  if (/^[+\d][\d\s-]{4,}$/.test(term)) return { phone: term.replace(/[\s-]/g, '') };
  if (term.includes('@')) return { email: term };
  return { displayName: term };
}
