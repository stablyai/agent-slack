export async function withEnvironment<T>(
  overrides: Record<string, string | undefined>,
  work: () => T | Promise<T>,
): Promise<T> {
  const originalValues = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]] as const),
  );

  try {
    for (const [name, value] of Object.entries(overrides)) {
      setEnvironmentVariable(name, value);
    }
    return await work();
  } finally {
    for (const [name, value] of originalValues) {
      setEnvironmentVariable(name, value);
    }
  }
}

function setEnvironmentVariable(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
