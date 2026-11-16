/**
 * Checkpoints: a snapshot of the working folder before the agent changes it, so any turn can be
 * rolled back (after Cline's shadow-git checkpoints and Aider's /undo). The native harness keeps
 * them in a shadow git repo outside the project (src/core/checkpoints-git.ts); the web UI keeps
 * copies of its virtual files. Browser-safe interface.
 */

export interface Checkpoint {
  id: string;
  label: string;
  time: number;
  /** Files that differ from the current state (filled by list()). */
  changed?: number;
}

export interface CheckpointStore {
  /** Snapshot the folder now. Returns the new checkpoint, or undefined when nothing could be saved. */
  snapshot(label: string): Promise<Checkpoint | undefined>;
  /** Newest first. */
  list(limit?: number): Promise<Checkpoint[]>;
  /** Put the folder back as it was at this checkpoint. The current state is saved first, so a restore can be undone. */
  restore(id: string): Promise<{ restored: number; removed: number }>;
  /** Unified diff from a checkpoint to now. */
  diff(id: string): Promise<string>;
}

export const checkpointLabel = (prompt: string) => prompt.replace(/\s+/g, " ").trim().slice(0, 72) || "turn";
