import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  autocapturePropertiesForEvent,
  bindAutocaptureListeners,
  defaultAutocaptureOptions,
  isSensitiveElement,
  shouldCaptureValue,
  DEFAULT_BLOCK_CLASSES,
  DEFAULT_IGNORE_SELECTORS,
  type AutocaptureOptions,
} from './autocapture';

const OPTIONS: AutocaptureOptions = defaultAutocaptureOptions();

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  document.body.innerHTML = '';
});

// Dispatch a real DOM event on a real jsdom element and return the neutral props the
// extractor produces for it (undefined when gated out).
function capturePropsFor(el: Element, type: 'click' | 'change' | 'submit') {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'target', { value: el, enumerable: true });
  return autocapturePropertiesForEvent(event, OPTIONS);
}

describe('neutral default vocabulary carries no vendor prefix', () => {
  test('block classes / ignore selectors are neutral and namespace-prefixed, never ph-*', () => {
    for (const cls of DEFAULT_BLOCK_CLASSES) {
      expect(cls).not.toContain('ph-');
      expect(cls).not.toContain('posthog');
    }
    for (const sel of DEFAULT_IGNORE_SELECTORS) {
      expect(sel).not.toContain('ph-');
      expect(sel).not.toContain('posthog');
    }
    expect(DEFAULT_BLOCK_CLASSES).toContain('ak-no-capture');
    expect(DEFAULT_IGNORE_SELECTORS).toContain('.ak-no-autocapture');
    expect(DEFAULT_IGNORE_SELECTORS).toContain('[data-ak-no-autocapture]');
  });
});

describe('element metadata → neutral keys (de-branded)', () => {
  test('a click on a button yields event_type, elements_chain, el_text with NO $-prefix', () => {
    const button = document.createElement('button');
    button.textContent = 'Buy now';
    button.className = 'cta primary';
    button.id = 'buy';
    document.body.appendChild(button);

    const props = capturePropsFor(button, 'click');

    expect(props).toBeDefined();
    expect(props?.event_type).toBe('click');
    expect(props?.el_text).toBe('Buy now');
    expect(typeof props?.elements_chain).toBe('string');
    // No de-branded key leaked a vendor `$`-prefix.
    for (const key of Object.keys(props ?? {})) {
      expect(key).not.toContain('$');
    }
    // The chain carries the tag, classes and neutral attr scheme.
    const chain = String(props?.elements_chain);
    expect(chain).toContain('button');
    expect(chain).toContain('.cta');
    expect(chain).toContain('attr__id="buy"');
  });

  test('per-element props use neutral keys: tag_name / classes / nth_child / nth_of_type / attr__<name>', () => {
    const wrapper = document.createElement('div');
    wrapper.innerHTML =
      '<span></span><a href="/pricing" data-track="cta" class="link">Pricing</a>';
    document.body.appendChild(wrapper);
    const anchor = wrapper.querySelector('a') as HTMLAnchorElement;

    const props = capturePropsFor(anchor, 'click');
    const chain = String(props?.elements_chain);

    expect(chain).toContain('a');
    expect(chain).toContain('attr__href="/pricing"');
    expect(chain).toContain('attr__data-track="cta"');
    // nth_child = 2 (the span precedes the anchor); reflected in the chain.
    expect(chain).toContain('nth-child="2"');
  });

  test('el_text is truncated for long content', () => {
    const button = document.createElement('button');
    button.textContent = 'x'.repeat(2000);
    document.body.appendChild(button);

    const props = capturePropsFor(button, 'click');
    const text = String(props?.el_text);

    // makeSafeText caps direct text at 255 chars.
    expect(text.length).toBeLessThanOrEqual(255);
  });
});

describe('event/element gating decision tree', () => {
  test('a form captures on submit', () => {
    const form = document.createElement('form');
    document.body.appendChild(form);
    expect(capturePropsFor(form, 'submit')).toBeDefined();
  });

  test('a form does NOT capture on click', () => {
    const form = document.createElement('form');
    document.body.appendChild(form);
    expect(capturePropsFor(form, 'click')).toBeUndefined();
  });

  test('an input captures on change', () => {
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    expect(capturePropsFor(input, 'change')).toBeDefined();
  });

  test('a bare non-compatible div does NOT capture on click', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(capturePropsFor(div, 'click')).toBeUndefined();
  });

  test('the <html> element never captures', () => {
    expect(capturePropsFor(document.documentElement, 'click')).toBeUndefined();
  });

  test('a click whose target is a child of a compatible parent captures (parentIsUsefulElement)', () => {
    const button = document.createElement('button');
    const inner = document.createElement('span');
    inner.textContent = 'go';
    button.appendChild(inner);
    document.body.appendChild(button);

    expect(capturePropsFor(inner, 'click')).toBeDefined();
  });
});

describe('skip-class / ignore-selector suppression', () => {
  test('a block class on the target suppresses the whole event', () => {
    const button = document.createElement('button');
    button.className = 'ak-no-capture';
    button.textContent = 'secret';
    document.body.appendChild(button);

    expect(capturePropsFor(button, 'click')).toBeUndefined();
  });

  test('a block class on an ANCESTOR suppresses the whole event', () => {
    const wrapper = document.createElement('div');
    wrapper.className = 'ak-no-capture';
    const button = document.createElement('button');
    button.textContent = 'x';
    wrapper.appendChild(button);
    document.body.appendChild(wrapper);

    expect(capturePropsFor(button, 'click')).toBeUndefined();
  });

  test('the ignore selector (class) suppresses the event', () => {
    const button = document.createElement('button');
    button.className = 'ak-no-autocapture';
    document.body.appendChild(button);

    expect(capturePropsFor(button, 'click')).toBeUndefined();
  });

  test('the ignore selector (data attribute) suppresses the event', () => {
    const button = document.createElement('button');
    button.setAttribute('data-ak-no-autocapture', '');
    document.body.appendChild(button);

    expect(capturePropsFor(button, 'click')).toBeUndefined();
  });

  test('a custom block class overrides the default (override seam)', () => {
    const custom: AutocaptureOptions = {
      blockClasses: ['secret-widget'],
      ignoreSelectors: [],
    };
    const button = document.createElement('button');
    button.className = 'secret-widget';
    document.body.appendChild(button);
    const event = new Event('click', { bubbles: true });
    Object.defineProperty(event, 'target', { value: button, enumerable: true });

    expect(autocapturePropertiesForEvent(event, custom)).toBeUndefined();
    // The default block class no longer suppresses when the override omits it.
    button.className = 'ak-no-capture';
    const event2 = new Event('click', { bubbles: true });
    Object.defineProperty(event2, 'target', { value: button, enumerable: true });
    expect(autocapturePropertiesForEvent(event2, custom)).toBeDefined();
  });
});

describe('sensitive-value scrub (universal privacy floor)', () => {
  test('shouldCaptureValue rejects a credit-card-shaped value', () => {
    expect(shouldCaptureValue('4111111111111111')).toBe(false);
    expect(shouldCaptureValue('4111 1111 1111 1111')).toBe(false);
  });

  test('shouldCaptureValue rejects an SSN-shaped value', () => {
    expect(shouldCaptureValue('123-45-6789')).toBe(false);
  });

  test('shouldCaptureValue accepts an ordinary value', () => {
    expect(shouldCaptureValue('Buy now')).toBe(true);
    expect(shouldCaptureValue('')).toBe(true);
  });

  test('shouldCaptureValue rejects nullish', () => {
    expect(shouldCaptureValue(null)).toBe(false);
    expect(shouldCaptureValue(undefined)).toBe(false);
  });

  test('an attribute whose value looks like a credit card is NOT captured', () => {
    const button = document.createElement('button');
    button.setAttribute('data-card', '4111111111111111');
    button.textContent = 'pay';
    document.body.appendChild(button);

    const props = capturePropsFor(button, 'click');
    expect(String(props?.elements_chain)).not.toContain('4111111111111111');
    expect(String(props?.elements_chain)).not.toContain('attr__data-card');
  });

  test('a password input is sensitive and its value never appears', () => {
    const input = document.createElement('input');
    input.type = 'password';
    input.value = 'hunter2';
    input.name = 'pw';
    document.body.appendChild(input);

    // A password field is dropped entirely by shouldCaptureElement — no el_text.
    const props = capturePropsFor(input, 'change');
    expect(String(props?.elements_chain ?? '')).not.toContain('hunter2');
  });

  test('a hidden input contributes no captured value', () => {
    const input = document.createElement('input');
    input.type = 'hidden';
    input.value = 'secret-token';
    document.body.appendChild(input);

    const props = capturePropsFor(input, 'change');
    expect(String(props?.elements_chain ?? '')).not.toContain('secret-token');
  });

  test('isSensitiveElement flags text inputs, selects, textareas but not buttons', () => {
    const text = document.createElement('input');
    text.type = 'text';
    expect(isSensitiveElement(text)).toBe(true);

    const submit = document.createElement('input');
    submit.type = 'submit';
    expect(isSensitiveElement(submit)).toBe(false);

    expect(isSensitiveElement(document.createElement('select'))).toBe(true);
    expect(isSensitiveElement(document.createElement('textarea'))).toBe(true);
    expect(isSensitiveElement(document.createElement('button'))).toBe(false);
  });

  test('a sensitive element captures only the safe attribute set', () => {
    const input = document.createElement('input');
    input.type = 'text';
    input.name = 'email';
    input.setAttribute('aria-label', 'Email');
    input.setAttribute('data-secret', 'nope');
    document.body.appendChild(input);

    const chain = String(capturePropsFor(input, 'change')?.elements_chain);
    expect(chain).toContain('attr__aria-label="Email"');
    // A non-safe attribute on a sensitive element is dropped.
    expect(chain).not.toContain('attr__data-secret');
  });
});

describe('listener binding + teardown (SSR-guarded)', () => {
  test('binds capture-phase click/change/submit; a real click mints one props callback', () => {
    const seen: unknown[] = [];
    const unbind = bindAutocaptureListeners((props) => seen.push(props));
    const button = document.createElement('button');
    button.textContent = 'Go';
    document.body.appendChild(button);

    button.click();

    expect(seen).toHaveLength(1);
    unbind?.();
  });

  test('a real submit and change also fire', () => {
    const seen: unknown[] = [];
    const unbind = bindAutocaptureListeners((props) => seen.push(props));

    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.dispatchEvent(new Event('change', { bubbles: true }));

    const form = document.createElement('form');
    document.body.appendChild(form);
    form.dispatchEvent(new Event('submit', { bubbles: true }));

    expect(seen).toHaveLength(2);
    unbind?.();
  });

  test('the returned unbinder removes the listeners — a later click mints nothing', () => {
    const seen: unknown[] = [];
    const unbind = bindAutocaptureListeners((props) => seen.push(props));
    const button = document.createElement('button');
    document.body.appendChild(button);

    unbind?.();
    button.click();

    expect(seen).toHaveLength(0);
  });

  test('binding is SSR-guarded — no document ⇒ returns undefined and binds nothing', () => {
    const globals = globalThis as { document?: Document };
    const originalDocument = globals.document;
    // Simulate a non-DOM context by removing the document global.
    globals.document = undefined;
    try {
      const unbind = bindAutocaptureListeners(() => {
        throw new Error('should not fire in a non-DOM context');
      });
      expect(unbind).toBeUndefined();
    } finally {
      globals.document = originalDocument;
    }
  });
});
