/**
 * 从模型回复里取出 JSON 对象（按模板规整、AI 生成模板共用）。
 * 容忍外面包着 ```json 代码块、前后有说明文字；取不出来返回 undefined，由调用方说明是哪种回复坏了。
 */
export function extractJsonReply(reply: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(reply);
  const candidates = fenced ? [fenced[1], reply] : [reply];
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // 换下一个候选
    }
  }
  return undefined;
}
