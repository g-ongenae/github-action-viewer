// Demo mode's stand-in for the editor of the watch list: a made-up GitHub that knows a handful of
// repositories, and a list of maintained repositories kept in memory. Nothing is read from or
// written to a file, and nothing is asked to GitHub.

import { isRepositoryName, sameName } from '../core/repository-name.ts';
import type {
  CatalogueRepository,
  RepositoryCatalogue,
  WatchListChange,
} from '../server/payload.ts';
import { WatchListError, type WatchListEditor } from '../server/watch-list-editor.ts';

/** What the made-up GitHub lists for the demo user, most recently pushed first. */
export const DEMO_CATALOGUE: readonly CatalogueRepository[] = [
  { fullName: 'demo-user/rocket-launcher', private: false },
  { fullName: 'acme-labs/web-console', private: true },
  { fullName: 'acme-labs/billing-service', private: true },
  { fullName: 'demo-user/dotfiles', private: true },
  { fullName: 'acme-labs/design-system', private: false },
  { fullName: 'acme-labs/data-pipeline', private: true },
  { fullName: 'nebula-works/star-charts', private: true },
  { fullName: 'acme-labs/mobile-app', private: true },
  { fullName: 'demo-user/legacy-tools', private: false },
  { fullName: 'nebula-works/telemetry', private: false },
];

/** Public repositories of other people: not listed, but found when added by name. */
const DEMO_PUBLIC: readonly string[] = ['octo-org/handbook', 'open-tools/yaml-lint'];

export class DemoWatchList implements WatchListEditor {
  #maintained: readonly string[];
  readonly #onChange: () => void;

  /** `onChange` is called after each change of {@link maintained}. */
  constructor(maintained: readonly string[], onChange: () => void) {
    this.#maintained = maintained;
    this.#onChange = onChange;
  }

  get maintained(): readonly string[] {
    return this.#maintained;
  }

  catalogue(): Promise<RepositoryCatalogue> {
    return Promise.resolve({ repositories: DEMO_CATALOGUE, complete: true });
  }

  add(repository: string): Promise<WatchListChange> {
    return this.#change(repository, (listed) => {
      const known = [...DEMO_CATALOGUE.map((entry) => entry.fullName), ...DEMO_PUBLIC].find(
        (name) => sameName(name, repository),
      );
      if (known === undefined) {
        throw new WatchListError(
          404,
          `${repository} was not found on GitHub, or the token cannot read it.`,
        );
      }
      return { repository: known, maintained: listed ? null : [...this.#maintained, known] };
    });
  }

  remove(repository: string): Promise<WatchListChange> {
    return this.#change(repository, (listed) => ({
      repository,
      maintained: listed ? this.#maintained.filter((name) => !sameName(name, repository)) : null,
    }));
  }

  /** `decide` returns the new list, or null to keep the current one. */
  #change(
    repository: string,
    decide: (listed: boolean) => { repository: string; maintained: readonly string[] | null },
  ): Promise<WatchListChange> {
    try {
      if (!isRepositoryName(repository)) {
        throw new WatchListError(400, 'Expected a repository as owner/name.');
      }
      const decision = decide(this.#maintained.some((name) => sameName(name, repository)));
      if (decision.maintained !== null) {
        this.#maintained = decision.maintained;
        this.#onChange();
      }
      return Promise.resolve({
        repository: decision.repository,
        changed: decision.maintained !== null,
        maintainedRepositories: this.#maintained,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }
}
