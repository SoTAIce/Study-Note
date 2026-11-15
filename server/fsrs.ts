/**
 * FSRS 间隔复习调度（srs-001），纯函数。
 *
 * 公式与默认参数照搬开源参考实现 py-fsrs 6.x（FSRS-6，21 个参数），区别只有：
 * - 不加随机抖动（fuzz）：同样的复习记录永远算出同样的结果，日志重放可复现；
 * - 学习步只有 10 分钟一步，重学步 10 分钟一步（新卡「记得」直接进入按天复习）。
 * 测试用参考实现在同样设置下算出的数值核对（server/tests/fsrs.test.ts）。
 */

export type Grade = 1 | 2 | 3 | 4; // 忘了 / 困难 / 记得 / 简单

export type CardState = {
  state: "learning" | "review" | "relearning";
  /** 学习 / 重学步序号；review 时为 null */
  step: number | null;
  stability: number;
  difficulty: number;
  /** 下次到期（毫秒时间戳） */
  due: number;
  /** 上次复习（毫秒时间戳） */
  last: number;
  reps: number;
  lapses: number;
};

export const DEFAULT_PARAMETERS = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629,
  1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
] as const;

const MINUTE = 60_000;
const DAY = 86_400_000;
const LEARNING_STEPS = [10 * MINUTE];
const RELEARNING_STEPS = [10 * MINUTE];
const DESIRED_RETENTION = 0.9;
const MAX_INTERVAL_DAYS = 36500;
const STABILITY_MIN = 0.001;

const w = DEFAULT_PARAMETERS;
const DECAY = -w[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;

const clampD = (d: number): number => Math.min(Math.max(d, 1), 10);
const clampS = (s: number): number => Math.max(s, STABILITY_MIN);

function initialStability(g: Grade): number {
  return clampS(w[g - 1]);
}

function initialDifficulty(g: Grade, clamp = true): number {
  const d = w[4] - Math.exp(w[5] * (g - 1)) + 1;
  return clamp ? clampD(d) : d;
}

function nextInterval(stability: number): number {
  const days = (stability / FACTOR) * (DESIRED_RETENTION ** (1 / DECAY) - 1);
  return Math.min(Math.max(Math.round(days), 1), MAX_INTERVAL_DAYS);
}

function shortTermStability(s: number, g: Grade): number {
  let inc = Math.exp(w[17] * (g - 3 + w[18])) * s ** -w[19];
  if (g >= 2) inc = Math.max(inc, 1);
  return clampS(s * inc);
}

function nextDifficulty(d: number, g: Grade): number {
  const delta = -(w[6] * (g - 3));
  const damped = d + ((10 - d) * delta) / 9;
  return clampD(w[7] * initialDifficulty(4, false) + (1 - w[7]) * damped);
}

/** 到某个时刻还记得的概率（经过的天数按整天算，和参考实现一致） */
export function retrievability(card: CardState, now: number): number {
  const elapsed = Math.max(0, Math.floor((now - card.last) / DAY));
  return (1 + (FACTOR * elapsed) / card.stability) ** DECAY;
}

function nextStability(d: number, s: number, r: number, g: Grade): number {
  if (g === 1) {
    const longTerm = w[11] * d ** -w[12] * ((s + 1) ** w[13] - 1) * Math.exp((1 - r) * w[14]);
    const shortTerm = s / Math.exp(w[17] * w[18]);
    return clampS(Math.min(longTerm, shortTerm));
  }
  const hard = g === 2 ? w[15] : 1;
  const easy = g === 4 ? w[16] : 1;
  return clampS(s * (1 + Math.exp(w[8]) * (11 - d) * s ** -w[9] * (Math.exp((1 - r) * w[10]) - 1) * hard * easy));
}

/** 按步数安排（学习 / 重学）：返回下一步的间隔毫秒和步号；走完了返回 null（转入按天复习） */
function stepInterval(steps: number[], step: number, g: Grade): { ms: number; step: number } | null {
  if (step >= steps.length && g >= 2) return null;
  if (g === 1) return { ms: steps[0], step: 0 };
  if (g === 2) {
    if (step === 0 && steps.length === 1) return { ms: steps[0] * 1.5, step };
    if (step === 0 && steps.length >= 2) return { ms: (steps[0] + steps[1]) / 2, step };
    return { ms: steps[step], step };
  }
  if (g === 3) return step + 1 === steps.length ? null : { ms: steps[step + 1], step: step + 1 };
  return null;
}

/** 复习一次：card 为 null 表示新卡第一次学 */
export function review(card: CardState | null, g: Grade, now: number): CardState {
  if (!card) {
    const fresh: CardState = {
      state: "learning",
      step: 0,
      stability: initialStability(g),
      difficulty: initialDifficulty(g),
      due: now,
      last: now,
      reps: 0,
      lapses: 0,
    };
    return schedule(fresh, g, now, "learning");
  }
  const sinceDays = Math.floor((now - card.last) / DAY);
  const next = { ...card };
  if (sinceDays < 1) {
    next.stability = shortTermStability(card.stability, g);
  } else {
    next.stability = nextStability(card.difficulty, card.stability, retrievability(card, now), g);
  }
  next.difficulty = nextDifficulty(card.difficulty, g);
  return schedule(next, g, now, card.state);
}

function schedule(card: CardState, g: Grade, now: number, from: CardState["state"]): CardState {
  const out: CardState = { ...card, last: now, reps: card.reps + 1 };
  const toReview = () => {
    out.state = "review";
    out.step = null;
    out.due = now + nextInterval(out.stability) * DAY;
  };
  if (from === "review") {
    if (g === 1) {
      out.state = "relearning";
      out.step = 0;
      out.lapses = card.lapses + 1;
      out.due = now + RELEARNING_STEPS[0];
    } else {
      toReview();
    }
    return out;
  }
  const steps = from === "learning" ? LEARNING_STEPS : RELEARNING_STEPS;
  const next = stepInterval(steps, card.step ?? 0, g);
  if (!next) {
    toReview();
  } else {
    out.state = from;
    out.step = next.step;
    out.due = now + next.ms;
  }
  return out;
}

/** 四档分别打下去的结果（按钮上显示下次间隔用） */
export function preview(card: CardState | null, now: number): Record<Grade, CardState> {
  return { 1: review(card, 1, now), 2: review(card, 2, now), 3: review(card, 3, now), 4: review(card, 4, now) };
}

/** 熟练度：没复习过是新卡；稳定性 ≥ 21 天算熟练 */
export function mastery(card: CardState | null): "new" | "learning" | "mastered" {
  if (!card) return "new";
  return card.state === "review" && card.stability >= 21 ? "mastered" : "learning";
}
