import {
  BUDGET_TIERS,
  BudgetTier,
  CostModel,
  COST_MODELS,
  DeckBuildRequest,
  DeckBuildResult,
  isSingletonFormat,
  MTG_COLORS,
  MTG_FORMATS,
  MtgColor,
  MtgFormat,
  normalizeColors,
  POWER_LEVELS,
  PowerLevel
} from "../types/mtg.js";
import { DeckBuilderService } from "./deckbuilder.js";

export const PLAYSTYLES = ["aggro", "midrange", "control", "combo"] as const;
export type Playstyle = (typeof PLAYSTYLES)[number];

export type WizardState = {
  format?: MtgFormat;
  colors?: MtgColor[];
  playstyle?: Playstyle;
  strategy?: string;
  mechanics?: string[];
  commander?: string;
  budget?: BudgetTier;
  powerLevel?: PowerLevel;
  costModel?: CostModel;
  /** Set once the optional-preferences round has been asked, so it is asked only once. */
  skippedOptional?: boolean;
};

export type WizardQuestion = {
  field: keyof WizardState;
  prompt: string;
  options?: readonly string[];
};

export type WizardResult =
  | {
      status: "questions";
      state: WizardState;
      questions: WizardQuestion[];
      readyToBuild: boolean;
      instructions: string;
    }
  | {
      status: "deck";
      state: WizardState;
      deck: DeckBuildResult;
    };

const MAX_QUESTIONS_PER_TURN = 3;

export function nextQuestions(state: WizardState): WizardQuestion[] {
  const questions: WizardQuestion[] = [];
  if (!state.format) {
    questions.push({
      field: "format",
      prompt: "どのフォーマットでデッキを組みますか?",
      options: MTG_FORMATS
    });
  }
  if (!state.colors?.length) {
    questions.push({
      field: "colors",
      prompt: "デッキのカラーを選んでください(複数可、C=無色)。",
      options: MTG_COLORS
    });
  }
  if (!state.playstyle) {
    questions.push({
      field: "playstyle",
      prompt: "プレイスタイルはどれが好みですか?",
      options: PLAYSTYLES
    });
  }
  if (state.format && isSingletonFormat(state.format) && !state.commander) {
    questions.push({
      field: "commander",
      prompt: "統率者(コマンダー)にしたいカードがあれば教えてください(任意)。"
    });
  }
  if (!state.skippedOptional) {
    questions.push(
      {
        field: "mechanics",
        prompt: "重視したいキーワード能力やテーマがあれば教えてください(例: tokens, lifegain, graveyard)(任意)。"
      },
      { field: "budget", prompt: "予算帯はどうしますか?(任意)", options: BUDGET_TIERS },
      { field: "powerLevel", prompt: "目指すパワーレベルは?(任意)", options: POWER_LEVELS },
      { field: "costModel", prompt: "紙(paper)とMTGアリーナ(arena)のどちら基準で組みますか?(任意)", options: COST_MODELS }
    );
  }
  return questions.slice(0, MAX_QUESTIONS_PER_TURN);
}

export function isReady(state: WizardState): boolean {
  return Boolean(state.format && state.colors?.length && state.playstyle);
}

export function toBuildRequest(state: WizardState): DeckBuildRequest {
  const format = state.format!;
  const colors = normalizeColors(state.colors ?? []);
  const playstyle = state.playstyle;
  // aggro/control map to concrete Scryfall query terms in mechanicQuery, so feed
  // the playstyle in as a mechanic; midrange/combo only inform the strategy text.
  const mechanics = [...(state.mechanics ?? [])];
  if (playstyle && (playstyle === "aggro" || playstyle === "control") && !mechanics.includes(playstyle)) {
    mechanics.push(playstyle);
  }
  const strategy =
    state.strategy ?? [playstyle ?? "midrange", ...(state.mechanics ?? [])].join(" ").trim();
  return {
    format,
    colors,
    strategy,
    mechanics: mechanics.length ? mechanics : undefined,
    commander: state.commander,
    budget: state.budget ?? "any",
    powerLevel: state.powerLevel ?? "focused",
    costModel: state.costModel ?? "paper",
    includeSideboard: true
  };
}

export async function runWizard(
  builder: DeckBuilderService,
  state: WizardState,
  finalize: boolean
): Promise<WizardResult> {
  const canFinalize = Boolean(state.format && state.colors?.length);
  if (isReady(state) || (finalize && canFinalize)) {
    const normalized: WizardState = { ...state, skippedOptional: true };
    return {
      status: "deck",
      state: normalized,
      deck: await builder.buildDeck(toBuildRequest(normalized))
    };
  }

  const questions = nextQuestions(state);
  // Once the optional round has been shown alongside the last required question,
  // don't repeat it: mark it as asked when only optional questions remain.
  const onlyOptionalLeft = questions.every((q) =>
    ["mechanics", "budget", "powerLevel", "costModel", "commander"].includes(q.field)
  );
  const nextState: WizardState = onlyOptionalLeft ? { ...state, skippedOptional: true } : state;
  return {
    status: "questions",
    state: nextState,
    questions,
    readyToBuild: canFinalize,
    instructions:
      "ユーザーに questions を尋ね、回答を state にマージして deck_wizard を再度呼び出してください。" +
      (canFinalize
        ? " 現在の state だけでも finalize:true で即デッキを構築できます。"
        : " format と colors が揃うと finalize:true で即構築できます。")
  };
}
