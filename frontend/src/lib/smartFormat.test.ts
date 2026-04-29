import { describe, it, expect } from "vitest";
import { applySmartFormat } from "./smartFormat";

describe("applySmartFormat", () => {
  describe("emails", () => {
    it("converts 'name at host dot tld' to an email", () => {
      expect(applySmartFormat("send to alice at example dot com today")).toBe(
        "send to alice@example.com today"
      );
    });

    it("handles multi-segment domains", () => {
      expect(
        applySmartFormat("hello bob at mail dot example dot co dot uk")
      ).toBe("hello bob@mail.example.co.uk");
    });

    it("leaves standalone 'at' alone when not email-shaped", () => {
      expect(applySmartFormat("meet at the office")).toBe(
        "meet at the office"
      );
    });
  });

  describe("urls", () => {
    it("collapses 'w w w' to 'www' and joins 'dot' separators", () => {
      expect(applySmartFormat("visit w w w dot voxlen dot ai")).toBe(
        "visit www.voxlen.ai"
      );
    });

    it("expands spoken scheme", () => {
      expect(
        applySmartFormat("go to https colon slash slash voxlen dot ai")
      ).toBe("go to https://voxlen.ai");
    });
  });

  describe("social", () => {
    it("expands 'hashtag foo' to '#foo'", () => {
      expect(applySmartFormat("tag as hashtag productivity please")).toBe(
        "tag as #productivity please"
      );
    });

    it("expands 'at username alice' to '@alice'", () => {
      expect(applySmartFormat("message at username alice now")).toBe(
        "message @alice now"
      );
    });
  });

  describe("digit runs", () => {
    it("collapses a run of spoken digits into a numeric block", () => {
      expect(applySmartFormat("reference two one three four five")).toBe(
        "reference 21345"
      );
    });

    it("leaves short runs alone (< 3 digits)", () => {
      expect(applySmartFormat("see page two")).toBe("see page two");
    });

    it("treats 'oh' as zero inside digit runs", () => {
      expect(applySmartFormat("dial oh two one five nine")).toBe(
        "dial 02159"
      );
    });
  });

  describe("markdown leaders", () => {
    it("turns 'heading one' into '# '", () => {
      expect(applySmartFormat("heading one introduction")).toBe(
        "# introduction"
      );
    });

    it("turns 'heading two' into '## '", () => {
      expect(applySmartFormat("heading two overview")).toBe("## overview");
    });

    it("turns 'bullet point' into '- '", () => {
      expect(applySmartFormat("bullet point first item")).toBe(
        "- first item"
      );
    });

    it("turns 'block quote' into '> '", () => {
      expect(applySmartFormat("block quote this is important")).toBe(
        "> this is important"
      );
    });
  });

  describe("inline markdown wrappers", () => {
    it("wraps 'bold ... end bold' in **", () => {
      expect(applySmartFormat("this is bold critical end bold point")).toBe(
        "this is **critical** point"
      );
    });

    it("wraps 'italic ... end italic' in *", () => {
      expect(applySmartFormat("italic emphasis end italic here")).toBe(
        "*emphasis* here"
      );
    });

    it("wraps 'code ... end code' in backticks", () => {
      expect(applySmartFormat("run code npm test end code now")).toBe(
        "run `npm test` now"
      );
    });
  });

  describe("options", () => {
    it("can disable individual transforms", () => {
      expect(
        applySmartFormat("alice at example dot com", { emails: false })
      ).toContain("at example");
    });
  });

  describe("edge cases", () => {
    it("returns empty string unchanged", () => {
      expect(applySmartFormat("")).toBe("");
    });

    it("is idempotent on already-formatted text", () => {
      const input = "email me at alice@example.com";
      expect(applySmartFormat(input)).toBe(input);
    });
  });
});
