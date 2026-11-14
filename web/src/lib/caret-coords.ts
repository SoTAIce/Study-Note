/**
 * 正文框里某个字符位置的坐标（相对正文框左上角，已扣掉滚动）。
 * 做法：照着正文框的排版建一个看不见的影子 div，量里面标记的位置。
 */
const COPIED = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "letterSpacing",
  "lineHeight",
  "tabSize",
  "textIndent",
  "textTransform",
  "wordSpacing",
  "wordBreak",
  "overflowWrap",
  "whiteSpace",
] as const;

function buildMirror(textarea: HTMLTextAreaElement): { mirror: HTMLDivElement; style: CSSStyleDeclaration } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  const target = mirror.style as unknown as Record<string, string>;
  const source = style as unknown as Record<string, string>;
  for (const name of COPIED) target[name] = source[name];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflow = "hidden";
  mirror.style.height = "auto";
  // 宽度按正文框的可用宽度（不含滚动条），否则折行位置对不上
  const padX = (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0);
  mirror.style.boxSizing = "content-box";
  mirror.style.borderWidth = "0";
  mirror.style.width = `${Math.max(0, textarea.clientWidth - padX)}px`;
  return { mirror, style };
}

/**
 * 一组字符位置在正文框内容里的顶端位置（不扣滚动，扣掉上内边距），分栏同步滚动用。
 * 一次排版量完，offsets 需从小到大。
 */
export function textTops(textarea: HTMLTextAreaElement, offsets: number[]): number[] {
  const { mirror, style } = buildMirror(textarea);
  const value = textarea.value;
  const markers: HTMLSpanElement[] = [];
  let last = 0;
  for (const offset of offsets) {
    const at = Math.max(last, Math.min(offset, value.length));
    mirror.appendChild(document.createTextNode(value.slice(last, at)));
    const marker = document.createElement("span");
    marker.textContent = "\u200b";
    mirror.appendChild(marker);
    markers.push(marker);
    last = at;
  }
  mirror.appendChild(document.createTextNode(value.slice(last)));
  document.body.appendChild(mirror);
  const padding = Number.parseFloat(style.paddingTop) || 0;
  const tops = markers.map((marker) => marker.offsetTop - padding);
  mirror.remove();
  return tops;
}

export function caretCoords(textarea: HTMLTextAreaElement, position: number): { top: number; left: number; height: number } {
  const { mirror, style } = buildMirror(textarea);
  mirror.textContent = textarea.value.slice(0, position);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(position, position + 1) || "​";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.5;
  const coords = {
    top: marker.offsetTop - textarea.scrollTop,
    left: marker.offsetLeft - textarea.scrollLeft,
    height: lineHeight,
  };
  mirror.remove();
  return coords;
}
