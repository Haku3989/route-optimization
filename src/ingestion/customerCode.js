/**
 * Customer-code parsing for the Presale workbook.
 *
 * The Presale `CustomerName` column is a concatenation of the shared
 * `Customer_Code` and the human shop name, in the form
 * `"<Customer_Code> <name...>"` (code prefix, a single whitespace gap, then the
 * name — which may itself contain spaces). `parseCustomerCode` splits the
 * leading code token off the front so the presale rows can be joined to the
 * Shop_Master by `Customer_code` (Requirement 5.1).
 *
 * When the value has no leading code token (empty, whitespace-only, or a single
 * token with no separating name), `code` is returned as `null` and the whole
 * text is treated as the name.
 */

/**
 * Split the leading `Customer_Code` token out of a Presale `CustomerName`.
 *
 * @param {string|null|undefined} customerName  raw `CustomerName` cell value
 * @returns {{ code: string|null, name: string }}
 *   `code` is the leading whitespace-delimited token when the value contains a
 *   code prefix followed by a name; otherwise `null`. `name` is the remaining
 *   text (trimmed). Both results are trimmed.
 */
export function parseCustomerCode(customerName) {
  if (customerName === null || customerName === undefined) {
    return { code: null, name: "" };
  }

  const text = String(customerName).trim();
  if (text === "") {
    return { code: null, name: "" };
  }

  // A well-formed value is "<code><whitespace><name...>": the code is the
  // leading run of non-whitespace characters, the name is everything after the
  // first whitespace gap. A single token (no separating whitespace) has no
  // code prefix, so it is treated entirely as the name.
  const match = text.match(/^(\S+)\s+(.*)$/);
  if (!match) {
    return { code: null, name: text };
  }

  return { code: match[1].trim(), name: match[2].trim() };
}
