import { expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
it("installer validates inputs, preserves existing env and uses compose with a fake Docker", () => {
  // Adapt only privileged host setup; exercise prompts, DNS, env, compose and health unchanged.
  const root = mkdtempSync(resolve(".install-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = readFileSync("install.sh", "utf8")
    .replace(/if \[\[ \$\{EUID\} -ne 0 \]\]; then[\s\S]*?\nfi/, "")
    .replace("source /etc/os-release", "ID=ubuntu\nVERSION_CODENAME=noble");
  writeFileSync(join(root, "install.sh"), script);
  const command = (name: string, body: string) =>
    writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o755 });
  command("docker", 'printf "%s\\n" "$*" >> "$TEST_LOG"\nexit 0\n');
  command(
    "curl",
    'if [[ "$*" == *ipify* ]]; then echo "192.0.2.10"; else echo \'{"ok":true}\'; fi\n',
  );
  command("getent", 'echo "192.0.2.10 STREAM kx7qpa.example.com"\n');
  command("apt-get", 'echo "Unexpected privileged install" >&2; exit 99\n');
  const env = {
    ...process.env,
    PATH: bin + ":" + process.env.PATH,
    TEST_LOG: join(root, "docker.log"),
  };
  try {
    const first = spawnSync("bash", [join(root, "install.sh")], {
      env,
      input:
        "https://bad-domain\nkx7qpa.example.com\nhttp://wrong.example.com\nhttps://www.example.com\nBAD\nG-TEST\n",
      encoding: "utf8",
    });
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout).toContain('<script async src="https://kx7qpa.example.com/s.js"></script>');
    const initial = readFileSync(join(root, ".env"), "utf8");
    expect(initial).toContain("COOKIE_DOMAIN=example.com");
    expect(initial).not.toContain("GA4_API_SECRET");
    expect(initial).toMatch(/COOKIE_SECRET=[a-f0-9]{64}/);
    expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
    const second = spawnSync("bash", [join(root, "install.sh")], {
      env,
      input: "",
      encoding: "utf8",
    });
    expect(second.status, second.stderr).toBe(0);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(initial);
    expect(readFileSync(join(root, "docker.log"), "utf8")).toContain("compose up -d --build");
    command("getent", "exit 2\n");
    const missing = spawnSync("bash", [join(root, "install.sh")], { env, encoding: "utf8" });
    expect(missing.status).toBe(1);
    expect(missing.stdout).toContain("DNS does not yet match");
    expect(readFileSync(join(root, ".env"), "utf8")).toBe(initial);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [tracker, site, domain, succeeds] of [
  ["kx7qpa.eu.example.com", "https://www.example.com", "example.com", true],
  ["kx7qpa.eu.example.co.uk", "https://www.example.co.uk", "example.co.uk", true],
  ["example.co.uk", "https://www.example.co.uk", "example.co.uk", true],
  ["kx7qpa.other.example", "https://www.example.com", "example.com", false],
] as const) {
  it(`installer: ${tracker} for ${site}`, () => {
    const root = mkdtempSync(resolve(".install-test-"));
    const bin = join(root, "bin");
    mkdirSync(bin);
    const command = (name: string, body: string) =>
      writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o755 });
    const script = readFileSync("install.sh", "utf8")
      .replace(/if \[\[ \$\{EUID\} -ne 0 \]\]; then[\s\S]*?\nfi/, "")
      .replace("source /etc/os-release", "ID=ubuntu\nVERSION_CODENAME=noble");
    writeFileSync(join(root, "install.sh"), script);
    command("docker", "exit 0");
    command(
      "curl",
      'if [[ "$*" == *ipify* ]]; then echo "192.0.2.10"; else echo \'{"ok":true}\'; fi',
    );
    command("getent", 'echo "192.0.2.10 STREAM example.com"');
    command("apt-get", "exit 99");
    try {
      const result = spawnSync("bash", [join(root, "install.sh")], {
        env: { ...process.env, PATH: bin + ":" + process.env.PATH },
        input: `${tracker}\n${site}\nG-TEST\n`,
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(succeeds ? 0 : 1);
      if (succeeds)
        expect(readFileSync(join(root, ".env"), "utf8")).toContain("COOKIE_DOMAIN=" + domain);
      else expect(result.stdout).toContain("or change the website origin");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
it("update enforces owner-only permissions on both existing env and backup", () => {
  const root = mkdtempSync(resolve(".update-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const command = (name: string, body: string) =>
    writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o755 });
  writeFileSync(
    join(root, "update.sh"),
    readFileSync("update.sh", "utf8").replace(
      /if \[\[ \$\{EUID\} -ne 0 \]\]; then[\s\S]*?\nfi/,
      "",
    ),
  );
  writeFileSync(join(root, ".env"), "TEST_SECRET=keep-private\n", { mode: 0o644 });
  command("git", "exit 0");
  command("docker", "exit 0");
  command("date", "echo 20261105000000");
  try {
    const result = spawnSync("bash", [join(root, "update.sh")], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    for (const file of [".env", ".env.backup.20261105000000"]) {
      expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(root, file), "utf8")).toBe("TEST_SECRET=keep-private\n");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("update works for a sudo user when root owns .env, and runs Git as that user", () => {
  const root = mkdtempSync(resolve(".update-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const command = (name: string, body: string) =>
    writeFileSync(join(bin, name), "#!/bin/bash\n" + body, { mode: 0o755 });
  writeFileSync(join(root, "update.sh"), readFileSync("update.sh", "utf8"));
  writeFileSync(join(root, ".env"), "TEST_SECRET=keep-private\n", { mode: 0o600 });
  const log = join(root, "calls.log");
  // Without the fake sudo, touching .env fails the way it does for a non-root owner.
  command("sudo", '[[ $1 == -v ]] && exit 0\nAS_ROOT=1 "$@"\n');
  for (const [name, real] of [
    ["chmod", "/bin/chmod"],
    ["cp", "/bin/cp"],
  ] as const)
    command(
      name,
      `[[ -n \${AS_ROOT:-} ]] || { echo "${name}: Operation not permitted" >&2; exit 1; }\nexec ${real} "$@"\n`,
    );
  command("git", 'echo "git ${AS_ROOT:-user} $*" >> "$TEST_LOG"\nexit 0\n');
  command("docker", 'echo "docker ${AS_ROOT:-user} $*" >> "$TEST_LOG"\nexit 0\n');
  command("date", "echo 20261105000000");
  try {
    const result = spawnSync("bash", [join(root, "update.sh")], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH, TEST_LOG: log },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(statSync(join(root, ".env.backup.20261105000000")).mode & 0o777).toBe(0o600);
    const calls = readFileSync(log, "utf8");
    expect(calls).toContain("git user pull --ff-only");
    expect(calls).toContain("docker 1 compose up -d --wait");
    expect(calls).not.toContain("docker user");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("update stops with advice on a detached checkout, before any backup or Docker call", () => {
  const root = mkdtempSync(resolve(".update-test-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const script = readFileSync("update.sh", "utf8").replace(
    /if \[\[ \$\{EUID\} -ne 0 \]\]; then[\s\S]*?\nfi/,
    "",
  );
  writeFileSync(join(root, "update.sh"), script);
  writeFileSync(join(root, ".env"), "TEST_SECRET=keep-private\n", { mode: 0o600 });
  writeFileSync(join(bin, "docker"), '#!/bin/bash\necho "docker called" >&2\nexit 99\n', {
    mode: 0o755,
  });
  const git = (...args: string[]) => {
    const run = spawnSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args],
      { cwd: root, encoding: "utf8" },
    );
    expect(run.status, run.stderr).toBe(0);
  };
  try {
    git("init", "-q");
    git("add", "update.sh");
    git("commit", "-qm", "test");
    git("checkout", "-q", "--detach");
    const result = spawnSync("bash", [join(root, "update.sh")], {
      env: { ...process.env, PATH: bin + ":" + process.env.PATH },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not on a branch");
    expect(readdirSync(root).filter((name) => name.startsWith(".env.backup"))).toEqual([]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
