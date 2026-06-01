export const MERGE_DELTA_PROMPT =
  "This is a transcript delta from a {agentName} split session. " +
  "This is meant to give you context about what happened and what was learned in the split session. " +
  "Do not treat it as a new user request unless there is an explicit request inside it. Just keep it as context.";

export function formatMergePrompt(agentName: string): string {
  return MERGE_DELTA_PROMPT.replace("{agentName}", agentName);
}
