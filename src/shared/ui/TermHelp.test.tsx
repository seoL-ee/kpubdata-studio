import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { glossaryDescription, type GlossaryKey } from "@/shared/content/glossary";
import { TermHelp } from "./TermHelp";

describe("TermHelp", () => {
  it("typed glossary key의 정본 설명을 표시한다", () => {
    const term: GlossaryKey = "run";
    render(<TermHelp term={term} />);
    fireEvent.focus(screen.getByRole("button", { name: "run 용어 도움말" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent(glossaryDescription("run"));
  });
});
