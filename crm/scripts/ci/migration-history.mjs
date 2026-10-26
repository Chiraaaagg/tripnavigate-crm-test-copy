// Migration history rules (audit AUDIT-002 repair plan, step 6).
//
// The Supabase CLI keys supabase_migrations.schema_migrations by the numeric
// version prefix and applies files in name order, so:
//   - two files must never share a version (db reset fails on the duplicate);
//   - a migration that a database may already have applied must never be
//     edited or renamed (that database would silently keep the old body);
//   - a new migration must sort after every migration on the base branch,
//     or databases that already applied the base would meet it out of order.
// Deleting a migration is reported as a warning: only an approved revert may
// do it, and the affected databases then need `supabase migration repair`.
// A rename is allowed only when it is listed in approved-migration-renumbering.json
// (owner-approved, e.g. to remove duplicate versions) AND the content is unchanged
// (git rename similarity 100); it is reported as a warning for reviewers.
const VERSION = /^(\d+)_.+\.sql$/;

/**
 * @param {{ files: string[]; baseFiles?: string[]; changes?: Array<{ status: string; path: string; from?: string }>;
 *   approvedRenames?: Array<{ from: string; to: string }> }} input
 *   files: migration file names now; baseFiles: names on the base branch;
 *   changes: git --name-status entries (A/M/D/R...) for migration files (`from` = old path of a rename);
 *   approvedRenames: owner-approved renumbering (file names).
 * @returns {{ errors: string[]; warnings: string[] }}
 */
export function checkMigrationHistory({ files, baseFiles = [], changes = [], approvedRenames = [] }) {
  const errors = [];
  const warnings = [];
  const seen = new Map();
  for (const file of [...files].sort()) {
    const match = VERSION.exec(file);
    if (!match) {
      errors.push(`${file} has no numeric version prefix (expected <version>_<name>.sql)`);
      continue;
    }
    const version = match[1];
    if (seen.has(version)) errors.push(`duplicate migration version ${version}: ${seen.get(version)} and ${file}`);
    else seen.set(version, file);
  }
  const baseSet = new Set(baseFiles);
  const latestBase = [...baseFiles].map((f) => VERSION.exec(f)?.[1]).filter(Boolean).sort().at(-1);
  const approved = new Set(approvedRenames.map((r) => `${r.from}>${r.to}`));
  for (const { status, path, from } of changes) {
    const name = path.split('/').pop();
    const kind = status[0];
    if (kind === 'M' && baseSet.has(name)) errors.push(`existing migration ${name} was modified; add a new migration instead`);
    else if (kind === 'R') {
      const old = (from ?? '').split('/').pop();
      if (status === 'R100' && approved.has(`${old}>${name}`)) {
        warnings.push(`migration ${old} renumbered to ${name} (approved); databases that applied ${old} need \`supabase migration repair\``);
      } else {
        errors.push(`existing migration ${old || name} was renamed; add a new migration instead`);
      }
    }
    else if (kind === 'D') {
      warnings.push(`migration ${name} was deleted; only an approved revert may do this, and databases that applied it need \`supabase migration repair\``);
    } else if (kind === 'A' && latestBase) {
      const version = VERSION.exec(name)?.[1];
      if (version && version <= latestBase) {
        errors.push(`new migration ${name} sorts before ${latestBase} (latest on the base branch); databases would apply it out of order`);
      }
    }
  }
  return { errors, warnings };
}
