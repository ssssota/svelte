/** @import { ComponentContext, Effect, TemplateNode } from '#client' */
/** @import { Component, ComponentType, SvelteComponent } from '../../index.js' */
import { DEV } from 'esm-env';
import {
	clear_text_content,
	create_text,
	get_first_child,
	get_next_sibling,
	init_operations
} from './dom/operations.js';
import { HYDRATION_END, HYDRATION_ERROR, HYDRATION_START } from '../../constants.js';
import { push, pop, current_component_context, current_effect } from './runtime.js';
import { effect_root, branch } from './reactivity/effects.js';
import {
	hydrate_next,
	hydrate_node,
	hydrating,
	set_hydrate_node,
	set_hydrating
} from './dom/hydration.js';
import { array_from } from '../shared/utils.js';
import {
	all_registered_events,
	handle_event_propagation,
	root_event_handles
} from './dom/elements/events.js';
import { reset_head_anchor } from './dom/blocks/svelte-head.js';
import * as w from './warnings.js';
import * as e from './errors.js';
import { assign_nodes } from './dom/template.js';
import { is_passive_event } from '../../utils.js';

/**
 * This is normally true — block effects should run their intro transitions —
 * but is false during hydration (unless `options.intro` is `true`) and
 * when creating the children of a `<svelte:element>` that just changed tag
 */
export let should_intro = true;

/** @param {boolean} value */
export function set_should_intro(value) {
	should_intro = value;
}

/**
 * @param {Element} text
 * @param {string} value
 * @returns {void}
 */
export function set_text(text, value) {
	// @ts-expect-error
	if (value !== (text.__t ??= text.nodeValue)) {
		// @ts-expect-error
		text.nodeValue = text.__t = value;
	}
}

/**
 * Mounts a component to the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component.
 * Transitions will play during the initial render unless the `intro` option is set to `false`.
 *
 * @template {Record<string, any>} Props
 * @template {Record<string, any>} Exports
 * @param {ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>} component
 * @param {{} extends Props ? {
 * 		target: Document | Element | ShadowRoot;
 * 		anchor?: Node;
 * 		props?: Props;
 * 		events?: Record<string, (e: any) => any>;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}: {
 * 		target: Document | Element | ShadowRoot;
 * 		props: Props;
 * 		anchor?: Node;
 * 		events?: Record<string, (e: any) => any>;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}} options
 * @returns {Exports}
 */
export function mount(component, options) {
	const anchor = options.anchor ?? options.target.appendChild(create_text());
	return _mount(component, { ...options, anchor });
}

/**
 * Hydrates a component on the given target and returns the exports and potentially the props (if compiled with `accessors: true`) of the component
 *
 * @template {Record<string, any>} Props
 * @template {Record<string, any>} Exports
 * @param {ComponentType<SvelteComponent<Props>> | Component<Props, Exports, any>} component
 * @param {{} extends Props ? {
 * 		target: Document | Element | ShadowRoot;
 * 		props?: Props;
 * 		events?: Record<string, (e: any) => any>;
 *  	context?: Map<any, any>;
 * 		intro?: boolean;
 * 		recover?: boolean;
 * 	} : {
 * 		target: Document | Element | ShadowRoot;
 * 		props: Props;
 * 		events?: Record<string, (e: any) => any>;
 *  	context?: Map<any, any>;
 * 		intro?: boolean;
 * 		recover?: boolean;
 * 	}} options
 * @returns {Exports}
 */
export function hydrate(component, options) {
	init_operations();
	options.intro = options.intro ?? false;
	const target = options.target;
	const was_hydrating = hydrating;
	const previous_hydrate_node = hydrate_node;

	try {
		var anchor = /** @type {TemplateNode} */ (get_first_child(target));
		while (
			anchor &&
			(anchor.nodeType !== 8 || /** @type {Comment} */ (anchor).data !== HYDRATION_START)
		) {
			anchor = /** @type {TemplateNode} */ (get_next_sibling(anchor));
		}

		if (!anchor) {
			throw HYDRATION_ERROR;
		}

		set_hydrating(true);
		set_hydrate_node(/** @type {Comment} */ (anchor));
		hydrate_next();

		const instance = _mount(component, { ...options, anchor });

		if (
			hydrate_node === null ||
			hydrate_node.nodeType !== 8 ||
			/** @type {Comment} */ (hydrate_node).data !== HYDRATION_END
		) {
			w.hydration_mismatch();
			throw HYDRATION_ERROR;
		}

		set_hydrating(false);

		return /**  @type {Exports} */ (instance);
	} catch (error) {
		if (error === HYDRATION_ERROR) {
			if (options.recover === false) {
				e.hydration_failed();
			}

			// If an error occured above, the operations might not yet have been initialised.
			init_operations();
			clear_text_content(target);

			set_hydrating(false);
			return mount(component, options);
		}

		throw error;
	} finally {
		set_hydrating(was_hydrating);
		set_hydrate_node(previous_hydrate_node);
		reset_head_anchor();
	}
}

/** @type {Map<string, number>} */
const document_listeners = new Map();

/**
 * @template {Record<string, any>} Exports
 * @param {ComponentType<SvelteComponent<any>> | Component<any>} Component
 * @param {{
 * 		target: Document | Element | ShadowRoot;
 * 		anchor: Node;
 * 		props?: any;
 * 		events?: any;
 * 		context?: Map<any, any>;
 * 		intro?: boolean;
 * 	}} options
 * @returns {Exports}
 */
function _mount(Component, { target, anchor, props = {}, events, context, intro = true }) {
	init_operations();

	var registered_events = new Set();

	/** @param {Array<string>} events */
	var event_handle = (events) => {
		for (var i = 0; i < events.length; i++) {
			var event_name = events[i];

			if (registered_events.has(event_name)) continue;
			registered_events.add(event_name);

			var passive = is_passive_event(event_name);

			// Add the event listener to both the container and the document.
			// The container listener ensures we catch events from within in case
			// the outer content stops propagation of the event.
			target.addEventListener(event_name, handle_event_propagation, { passive });

			var n = document_listeners.get(event_name);

			if (n === undefined) {
				// The document listener ensures we catch events that originate from elements that were
				// manually moved outside of the container (e.g. via manual portals).
				document.addEventListener(event_name, handle_event_propagation, { passive });
				document_listeners.set(event_name, 1);
			} else {
				document_listeners.set(event_name, n + 1);
			}
		}
	};

	event_handle(array_from(all_registered_events));
	root_event_handles.add(event_handle);

	/** @type {Exports} */
	// @ts-expect-error will be defined because the render effect runs synchronously
	var component = undefined;

	var unmount = effect_root(() => {
		branch(() => {
			if (context) {
				push({});
				var ctx = /** @type {ComponentContext} */ (current_component_context);
				ctx.c = context;
			}

			if (events) {
				// We can't spread the object or else we'd lose the state proxy stuff, if it is one
				/** @type {any} */ (props).$$events = events;
			}

			if (hydrating) {
				assign_nodes(/** @type {TemplateNode} */ (anchor), null);
			}

			should_intro = intro;
			// @ts-expect-error the public typings are not what the actual function looks like
			component = Component(anchor, props) || {};
			should_intro = true;

			if (hydrating) {
				/** @type {Effect} */ (current_effect).nodes_end = hydrate_node;
			}

			if (context) {
				pop();
			}
		});

		return () => {
			for (var event_name of registered_events) {
				target.removeEventListener(event_name, handle_event_propagation);

				var n = /** @type {number} */ (document_listeners.get(event_name));

				if (--n === 0) {
					document.removeEventListener(event_name, handle_event_propagation);
					document_listeners.delete(event_name);
				} else {
					document_listeners.set(event_name, n);
				}
			}

			root_event_handles.delete(event_handle);
			mounted_components.delete(component);
		};
	});

	mounted_components.set(component, unmount);
	return component;
}

/**
 * References of the components that were mounted or hydrated.
 * Uses a `WeakMap` to avoid memory leaks.
 */
let mounted_components = new WeakMap();

/**
 * Unmounts a component that was previously mounted using `mount` or `hydrate`.
 * @param {Record<string, any>} component
 */
export function unmount(component) {
	const fn = mounted_components.get(component);
	if (DEV && !fn) {
		w.lifecycle_double_unmount();
		// eslint-disable-next-line no-console
		console.trace('stack trace');
	}
	fn?.();
}
