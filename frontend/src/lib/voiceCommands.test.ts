import { describe, it, expect, beforeEach, vi } from "vitest";

// Zustand store imports side-effect; stub the dictation store so tests stay
// pure and don't pull in Tauri/plugin-store code paths.
vi.mock("@/stores/dictation", () => {
  const state = {
    segments: [] as Array<{ id: string; text: string }>,
    status: "idle",
    capsLock: false,
    setStatus: vi.fn((s: string) => {
      state.status = s;
    }),
    setCapsLock: vi.fn((v: boolean) => {
      state.capsLock = v;
    }),
    getFullTranscript: () => state.segments.map((s) => s.text).join(" "),
  };
  return {
    useDictationStore: {
      getState: () => state,
      setState: (patch: Partial<typeof state>) => Object.assign(state, patch),
    },
  };
});

import { processVoiceCommands, executeVoiceCommand, applyTextCommand } from "./voiceCommands";
import { useDictationStore } from "@/stores/dictation";

describe("processVoiceCommands", () => {
  it("matches exact command", () => {
    const r = processVoiceCommands("new line");
    expect(r.matched).toBe(true);
    expect(r.action).toBe("insert_newline");
    expect(r.remainingText).toBe("");
  });

  it("matches trailing command and extracts remainder", () => {
    const r = processVoiceCommands("this is the text period");
    expect(r.matched).toBe(true);
    expect(r.action).toBe("insert_period");
    expect(r.remainingText).toBe("this is the text");
  });

  it("matches leading command", () => {
    const r = processVoiceCommands("new paragraph here we go");
    expect(r.matched).toBe(true);
    expect(r.action).toBe("insert_paragraph");
    expect(r.remainingText).toBe("here we go");
  });

  it("treats unknown text as no match", () => {
    const r = processVoiceCommands("a random sentence");
    expect(r.matched).toBe(false);
    expect(r.remainingText).toBe("a random sentence");
  });

  it("is case insensitive", () => {
    const r = processVoiceCommands("DELETE THAT");
    expect(r.matched).toBe(true);
    expect(r.action).toBe("delete_last");
  });

  it("supports alternates for the same action", () => {
    expect(processVoiceCommands("full stop").action).toBe("insert_period");
    expect(processVoiceCommands("dot").action).toBe("insert_period");
    expect(processVoiceCommands("scratch that").action).toBe("delete_last");
    expect(processVoiceCommands("stop dictation").action).toBe("stop");
  });
});

describe("executeVoiceCommand", () => {
  it("returns punctuation output for insert_period", () => {
    expect(executeVoiceCommand("insert_period")).toBe(".");
  });

  it("returns newline for insert_newline", () => {
    expect(executeVoiceCommand("insert_newline")).toBe("\n");
  });

  it("returns tab and space", () => {
    expect(executeVoiceCommand("insert_tab")).toBe("\t");
    expect(executeVoiceCommand("insert_space")).toBe(" ");
  });

  it("returns null for state-only actions", () => {
    expect(executeVoiceCommand("caps_on")).toBe(null);
    expect(executeVoiceCommand("caps_off")).toBe(null);
    expect(executeVoiceCommand("select_all")).toBe(null);
  });

  it("stop action sets idle status", () => {
    executeVoiceCommand("stop");
    expect(useDictationStore.getState().status).toBe("idle");
  });
});

describe("applyTextCommand", () => {
  beforeEach(() => {});

  it("appends newline directly", () => {
    expect(applyTextCommand("hello", "\n")).toBe("hello\n");
  });

  it("places punctuation flush against last word, then a space", () => {
    expect(applyTextCommand("hello ", ".")).toBe("hello. ");
    expect(applyTextCommand("hello", ",")).toBe("hello, ");
  });

  it("is a no-op when command output is null", () => {
    expect(applyTextCommand("hello", null)).toBe("hello");
  });
});
