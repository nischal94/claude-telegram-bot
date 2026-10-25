import { test, expect, spyOn, afterEach } from "bun:test";
import { readKeychain } from "./config";

let spy: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  spy?.mockRestore();
});

test("reads the Keychain through /usr/bin/security, not a PATH lookup", () => {
  spy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 0, stdout: Buffer.from("secret-value\n") } as any);
  expect(readKeychain("some-service")).toBe("secret-value");
  const argv = (spy.mock.calls[0] as unknown[])[0] as string[];
  expect(argv[0]).toBe("/usr/bin/security");
  expect(argv).toEqual(["/usr/bin/security", "find-generic-password", "-s", "some-service", "-w"]);
});

test("returns undefined when the Keychain has no such item", () => {
  spy = spyOn(Bun, "spawnSync").mockReturnValue({ exitCode: 44, stdout: Buffer.from("") } as any);
  expect(readKeychain("missing")).toBeUndefined();
});
