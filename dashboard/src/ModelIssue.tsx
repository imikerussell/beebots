export function ModelIssue({ error, connected, closed }: {
  error: string;
  connected: boolean;
  closed: boolean;
}) {
  const inconsistentScore = error === "Score disagrees with score probabilities";
  return <div className="model-issue" role="status">
    <strong>{inconsistentScore ? "Model answer rejected" : "Model decision unavailable"}</strong>
    <p>{inconsistentScore
      ? "The model’s confidence score did not match its own probabilities. This answer was ignored, so it could not trigger a trade."
      : "The latest model decision could not be used. No trade was placed from that answer."}</p>
    <p>{!connected ? "Last reported issue. Waiting for the engine to reconnect and update its status."
      : closed ? "This trading run is closed."
      : "The engine will try again on its next scheduled decision. Protective checks continue."}</p>
    <details><summary>Technical details</summary><p>{error}</p></details>
  </div>;
}
