/**
 * selfstore/flows - the user journeys as headless, tested state machines.
 *
 * A flow holds the state and ordering rules of a journey (connect a
 * destination, run a share panel, open an invitation) and nothing about how
 * it looks: subscribe, render the snapshot, call the actions. The rules were
 * extracted from a long series of production hotfixes - one popup per
 * gesture, cancel is not an error, password proven before anything attaches,
 * merge by default, transient failures never blank a panel - and each rule is
 * pinned by a test.
 *
 *   import { connectFlow } from 'selfstore/flows';
 *
 *   const flow = connectFlow(store, { drive: gisDriveAuth({ clientId }), file: true });
 *   flow.subscribe(render);       // Svelte: $flow works as-is; React: useSyncExternalStore
 *   flow.choose('drive');         // inside the user's click
 *
 * shareFlow and joinFlow drive an app-provided engine (the transport of links
 * and memberships is the app's business); connectFlow needs only the store.
 */

export {
	connectFlow,
	type ConnectFlow,
	type ConnectFlowOptions,
	type ConnectFlowOutcome,
	type ConnectKind,
	type ConnectResolution,
	type ConnectSnapshot,
	type ConnectStep,
	type ConnectTargets,
	type Connector,
	type FlowHost
} from '../flows/connect';
export {
	replicaFlow,
	REPLICA_ID,
	type ReplicaFlow,
	type ReplicaFlowOptions,
	type ReplicaSnapshot,
	type ReplicaStep
} from '../flows/replica';
export {
	shareFlow,
	type ShareBusy,
	type ShareEngine,
	type ShareFlow,
	type ShareLevel,
	type ShareLinkInfo,
	type ShareMemberInfo,
	type ShareSnapshot
} from '../flows/share';
export {
	joinFlow,
	type JoinEngine,
	type JoinFlow,
	type JoinOutcome,
	type JoinPreview,
	type JoinSnapshot,
	type JoinStep
} from '../flows/join';
export { withDeadline, type FlowStore } from '../flows/machine';
