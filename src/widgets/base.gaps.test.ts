// @vitest-environment happy-dom

import { describe, it, expect } from 'vitest';
import { FlowWidget, type WidgetLabels } from './base';

class TestWidget extends FlowWidget {
	protected defaults(): WidgetLabels {
		return {};
	}
	protected view(_: HTMLElement): void {}
	public getPacks(): Record<string, WidgetLabels> {
		return this.packs();
	}
}

// Register the custom element so that document.createElement works.
customElements.define('test-widget', TestWidget);

describe('FlowWidget.packs', () => {
	it('returns empty object', () => {
		const widget = document.createElement('test-widget') as TestWidget;
		const packs = widget.getPacks();
		expect(packs).toEqual({});
	});
});
