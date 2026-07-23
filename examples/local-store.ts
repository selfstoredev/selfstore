/**
 * The pull-model store ('selfstore/advanced'): YOUR app owns the data and
 * hands the store a gather/apply pair. Wire it to a tiny in-memory app using
 * memoryCache, so the whole save/hydrate lifecycle runs with no browser (as in
 * a unit test or SSR). Swap memoryCache() for indexedDbCache('todos') in a
 * real browser app - or start from the simple store (simple-store.ts) and
 * only come here when your state lives in its own reactive model.
 */
import {
	createLocalStore,
	memoryCache,
	type Snapshot,
	type StatusDescriptor
} from '../src/entries/advanced';

interface Todo {
	id: string;
	title: string;
	done: boolean;
}

export async function makeTodoStore() {
	let todos: Todo[] = [];

	const store = createLocalStore({
		app: 'todos',
		schemaVersion: 1,
		gather: (): Snapshot => ({ collections: { todos }, files: [] }),
		apply: (snap: Snapshot) => {
			todos = (snap.collections.todos ?? []) as Todo[];
		},
		cache: memoryCache(),
	});
	await store.init(); // hydrate whatever a previous session persisted

	return {
		add(title: string): void {
			todos = [...todos, { id: crypto.randomUUID(), title, done: false }];
			store.schedule(); // debounced auto-save
		},
		list: (): Todo[] => todos,
		flush: (): Promise<void> => store.flush(),
		status: (): StatusDescriptor => store.state.status,
		dispose: (): void => store.dispose(), // on unmount / teardown
	};
}
