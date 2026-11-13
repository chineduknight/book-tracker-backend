interface Explainable {
  explain(verbosity: string): Promise<unknown>;
}

function valuesOfKeyIn(plan: unknown, wantedKey: string, values = new Set<string>()): Set<string> {
  if (Array.isArray(plan)) plan.forEach((stage) => valuesOfKeyIn(stage, wantedKey, values));
  else if (typeof plan === 'object' && plan !== null) {
    for (const [key, value] of Object.entries(plan)) {
      if (key === wantedKey && typeof value === 'string') values.add(value);
      else valuesOfKeyIn(value, wantedKey, values);
    }
  }
  return values;
}

/** Index names anywhere in an explain output, including aggregation pipelines. */
export function indexNamesIn(plan: unknown): string[] {
  return [...valuesOfKeyIn(plan, 'indexName')];
}

/** Stage names (IXSCAN, SORT, TEXT_MATCH, …) anywhere in an explain output. */
export function stageNamesIn(plan: unknown): string[] {
  return [...valuesOfKeyIn(plan, 'stage')];
}

async function winningPlanOf(query: Explainable): Promise<unknown> {
  const explanation = (await query.explain('queryPlanner')) as {
    queryPlanner: { winningPlan: unknown };
  };
  return explanation.queryPlanner.winningPlan;
}

/** Indexes used by the plan MongoDB chose for a find query. */
export async function indexesUsedBy(query: Explainable): Promise<string[]> {
  return indexNamesIn(await winningPlanOf(query));
}

/** Stages of the plan MongoDB chose for a find query. */
export async function stagesUsedBy(query: Explainable): Promise<string[]> {
  return stageNamesIn(await winningPlanOf(query));
}
