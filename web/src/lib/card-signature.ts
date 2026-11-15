/**
 * 正文里和知识简卡有关的行拼成的签名（srs-001）：右栏的「这篇有几张简卡」只在它变了时重新查，
 * 平常改正文不多发请求（保存一次只发 1 个请求，见 E2E）。粗略即可：多算了只是多查一次。
 */
export function cardSignature(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => /^\s{0,3}>[ \t]?\[!card\]/i.test(line) || line.includes(" :: "))
    .map((line) => line.trim())
    .join("\n");
}
