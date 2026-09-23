import { connection } from "next/server";

const API_URL = process.env.API_URL ?? "http://localhost:4000";

type Health = { status: string; database: string };

async function getHealth(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_URL}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(2000),
    });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export default async function Home() {
  // Check the stack per request instead of once at build time.
  await connection();
  const health = await getHealth();

  const checks = [
    {
      label: "API",
      ok: health !== null,
      detail: health ? API_URL : `unreachable at ${API_URL}`,
    },
    {
      label: "Database",
      ok: health?.database === "up",
      detail: health?.database ?? "unknown",
    },
  ];

  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">music-sample-graph</h1>
        <p className="text-foreground/70">Explore the graph of who sampled whom.</p>
      </header>
      <ul className="divide-y divide-foreground/10 rounded-lg border border-foreground/10">
        {checks.map((check) => (
          <li key={check.label} className="flex items-center justify-between gap-4 px-4 py-3">
            <span className="font-medium">{check.label}</span>
            <span className="flex items-center gap-2 font-mono text-sm text-foreground/70">
              <span
                aria-hidden
                className={`size-2 rounded-full ${check.ok ? "bg-emerald-500" : "bg-rose-500"}`}
              />
              {check.detail}
            </span>
          </li>
        ))}
      </ul>
    </main>
  );
}
