/** 左栏筛选条件（与界面耦合，单独放 lib 里避免组件互相 import 类型）。 */
export type Filter =
  | { kind: "all" }
  | { kind: "inbox" }
  | { kind: "tag"; tag: string }
  | { kind: "timeline" }
  | { kind: "day"; day: string }
  | { kind: "group"; name: string }
  | { kind: "none" };

export function filterLabel(filter: Filter): string {
  switch (filter.kind) {
    case "all":
      return "全部笔记";
    case "inbox":
      return "收件箱";
    case "tag":
      return `#${filter.tag}`;
    case "timeline":
      return "时间流";
    case "day":
      return filter.day;
    case "group":
      return filter.name;
    case "none":
      return "未分组";
  }
}

export function sameFilter(a: Filter, b: Filter): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "tag" && b.kind === "tag") return a.tag === b.tag;
  if (a.kind === "day" && b.kind === "day") return a.day === b.day;
  // 组名不区分大小写（跟服务端一致），否则侧栏高亮会在拼写不同时失效
  if (a.kind === "group" && b.kind === "group") {
    return a.name.trim().toLowerCase() === b.name.trim().toLowerCase();
  }
  return true;
}
