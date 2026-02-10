import { describe, expect, test } from "bun:test";
import { parseArgs } from "../../src/cli";

describe("parseArgs", () => {
  test("parses serve command and home", () => {
    expect(parseArgs(["serve", "--home", "/tmp/xeno-home"])).toEqual({
      command: "serve",
      home: "/tmp/xeno-home",
    });
  });

  test("parses console command and home", () => {
    expect(parseArgs(["console", "--home", "./dev-home"])).toEqual({
      command: "console",
      home: "./dev-home",
    });
  });

  test("allows --home to be omitted", () => {
    expect(parseArgs(["serve"])).toEqual({
      command: "serve",
      home: undefined,
    });
  });

  test("parses install command", () => {
    expect(parseArgs(["install"])).toEqual({
      command: "install",
      home: undefined,
    });
  });

  test("parses uninstall command", () => {
    expect(parseArgs(["uninstall"])).toEqual({
      command: "uninstall",
      home: undefined,
    });
  });

  test("throws when unknown argument is passed", () => {
    expect(() => parseArgs(["serve", "--home", "/tmp/x", "--bad"])).toThrow(
      "Unknown argument: --bad",
    );
  });
});
