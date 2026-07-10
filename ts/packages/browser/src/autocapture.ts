import type { NeutralProperties } from 'analytics-kit';

// Minimal DOM autocapture, de-branded from posthog-js's autocapture.ts +
// autocapture-utils.ts. Capture-phase document listeners for click / change / submit
// turn a DOM interaction into a neutral property bag (elements chain + el_text +
// event_type + attr__ allowlist) that the caller mints into a normal neutral event.
//
// De-branding: every `$`-prefixed posthog key becomes a neutral key (`$elements_chain`
// → `elements_chain`, `$el_text` → `el_text`, `$event_type` → `event_type`); the skip
// class/attr names carry the neutral `ak-` library namespace, never a vendor prefix.
// The remote-config phone-home (`isEnabled` wait-for-server + `onRemoteConfig`
// `autocapture_opt_out`) is DELIBERATELY NOT PORTED — on/off is purely local config,
// so init never makes a gating network call.
//
// Every property key here is library-computed ⇒ TRUSTED: the caller runs the metadata
// through the normal capture pipeline WITHOUT allowlist-gating (element metadata is not
// consumer-supplied event props).

const NODE_TYPE_ELEMENT = 1;
const NODE_TYPE_TEXT = 3;
const NODE_TYPE_DOCUMENT_FRAGMENT = 11;

// Element text / attribute-value length caps (de-branded from posthog's limitText/255).
const TEXT_LENGTH_CAP = 1024;
const SAFE_TEXT_CAP = 255;

// The elements the tag→event gating treats as inherently "clickable-enough" to capture,
// and which mark a parent as a useful capture target. De-branded verbatim from posthog's
// autocaptureCompatibleElements.
const COMPATIBLE_ELEMENTS = ['a', 'button', 'form', 'input', 'select', 'textarea', 'label'];

// Input types that are NOT treated as sensitive (everything else on an <input> is).
const NON_SENSITIVE_INPUT_TYPES = ['button', 'checkbox', 'submit', 'reset'];

// Attributes still captured on a sensitive element — everything else is dropped there.
const SENSITIVE_ELEMENT_SAFE_ATTRS = ['name', 'id', 'class', 'aria-label'];

// Sensitive-value scrub (UNIVERSAL privacy floor, de-branded from posthog's
// shouldCaptureValue). A value that looks like a credit-card or social-security number
// is never captured. Names neutralized; regex literals ported verbatim.
const CC_CORE_PATTERN =
  '(4[0-9]{12}(?:[0-9]{3})?)|(5[1-5][0-9]{14})|(6(?:011|5[0-9]{2})[0-9]{12})|(3[47][0-9]{13})|(3(?:0[0-5]|[68][0-9])[0-9]{11})|((?:2131|1800|35[0-9]{3})[0-9]{11})';
const ANCHORED_CC_REGEX = new RegExp(`^(?:${CC_CORE_PATTERN})$`);
const SSN_CORE_PATTERN = '\\d{3}-?\\d{2}-?\\d{4}';
const ANCHORED_SSN_REGEX = new RegExp(`^(${SSN_CORE_PATTERN})$`);
const SENSITIVE_NAME_REGEX =
  /^cc|cardnum|ccnum|creditcard|csc|cvc|cvv|exp|pass|pwd|routing|seccode|securitycode|securitynum|socialsec|socsec|ssn/i;

// Angular view-encapsulation attributes churn per build ⇒ noise; excluded from capture.
function isAngularStyleAttr(name: string): boolean {
  return name.substring(0, 10) === '_ngcontent' || name.substring(0, 7) === '_nghost';
}

// The DOM opt-out vocabulary — neutral, `ak-`-namespaced (de-branded from posthog's
// `ph-no-capture` / `ph-no-autocapture` / `data-ph-no-autocapture`). Two distinct
// mechanisms: `blockClasses` suppress the WHOLE event when present on any ancestor;
// `ignoreSelectors` suppress autocapture for a matching subtree. Read through an options
// param (not hardcoded at the call sites) so a later config story can override them —
// the override seam exists now, populated with these neutral defaults.
export const DEFAULT_BLOCK_CLASSES = ['ak-no-capture'];
export const DEFAULT_IGNORE_SELECTORS = ['.ak-no-autocapture', '[data-ak-no-autocapture]'];

export interface AutocaptureOptions {
  // Classes that, on the target or any ancestor, suppress the ENTIRE autocapture event.
  blockClasses: string[];
  // CSS selectors that, matched by the target or any ancestor, ignore the event for
  // autocapture. Selector-shaped (not bare class names) to match the ancestor-walk check.
  ignoreSelectors: string[];
}

export function defaultAutocaptureOptions(): AutocaptureOptions {
  return {
    blockClasses: [...DEFAULT_BLOCK_CLASSES],
    ignoreSelectors: [...DEFAULT_IGNORE_SELECTORS],
  };
}

function isElementNode(node: Node | null | undefined): node is Element {
  return !!node && node.nodeType === NODE_TYPE_ELEMENT;
}

function isTextNode(node: Node | null | undefined): boolean {
  return !!node && node.nodeType === NODE_TYPE_TEXT;
}

function isShadowRoot(node: Node | null | undefined): node is ShadowRoot {
  return (
    !!node &&
    node.nodeType === NODE_TYPE_DOCUMENT_FRAGMENT &&
    isElementNode((node as ShadowRoot).host)
  );
}

function isTag(el: Element | null | undefined, tag: string): boolean {
  return !!el && !!el.tagName && el.tagName.toLowerCase() === tag;
}

function limitText(length: number, text: string): string {
  return text.length > length ? text.slice(0, length) + '...' : text;
}

function splitClassString(s: string): string[] {
  return s ? s.trim().split(/\s+/) : [];
}

// The className read is defensive: SVG elements expose an SVGAnimatedString, not a
// plain string, so pull `baseVal` / the `class` attribute in the object case.
function getClassNames(el: Element): string[] {
  const raw = el.className;
  if (typeof raw === 'string') {
    return splitClassString(raw);
  }
  const objectClass =
    (raw && typeof raw === 'object' && 'baseVal' in raw
      ? (raw as { baseVal: string }).baseVal
      : null) ??
    el.getAttribute('class') ??
    '';
  return splitClassString(objectClass);
}

export function shouldCaptureValue(value: string | null | undefined): boolean {
  if (value === null || value === undefined) {
    return false;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (ANCHORED_CC_REGEX.test(trimmed.replace(/[- ]/g, ''))) {
      return false;
    }
    if (ANCHORED_SSN_REGEX.test(trimmed)) {
      return false;
    }
  }
  return true;
}

// Concatenate ONLY direct text-node children (never element.textContent, which would
// pull sensitive nested child text), scrubbing each run and capping length.
function makeSafeText(s: string | null | undefined): string | null {
  if (s === null || s === undefined) {
    return null;
  }
  return s
    .trim()
    .split(/(\s+)/)
    .filter((token) => shouldCaptureValue(token))
    .join('')
    .replace(/[\r\n]/g, ' ')
    .replace(/[ ]+/g, ' ')
    .substring(0, SAFE_TEXT_CAP);
}

// A "sensitive" element captures only limited attributes: any free-text input (all
// input types except the safe list), select, textarea, or contenteditable.
export function isSensitiveElement(el: Element): boolean {
  const allowed = NON_SENSITIVE_INPUT_TYPES;
  return (
    (isTag(el, 'input') && !allowed.includes((el as HTMLInputElement).type)) ||
    isTag(el, 'select') ||
    isTag(el, 'textarea') ||
    el.getAttribute('contenteditable') === 'true'
  );
}

// Whether the element (and its ancestor chain) permits capture at all. A block class on
// any ancestor drops it; hidden/password inputs and sensitively-named fields drop it.
function shouldCaptureElement(el: Element, blockClasses: string[]): boolean {
  for (
    let cur: Element | null = el;
    cur && cur.parentNode && !isTag(cur, 'body');
    cur = cur.parentNode as Element | null
  ) {
    const classes = getClassNames(cur);
    if (classes.some((c) => blockClasses.includes(c))) {
      return false;
    }
  }

  const type = (el as HTMLInputElement).type || '';
  if (typeof type === 'string') {
    const lower = type.toLowerCase();
    if (lower === 'hidden' || lower === 'password') {
      return false;
    }
  }

  const name = (el as HTMLInputElement).name || el.id || '';
  if (typeof name === 'string' && SENSITIVE_NAME_REGEX.test(name.replace(/[^a-zA-Z0-9]/g, ''))) {
    return false;
  }

  return true;
}

function getSafeText(el: Element, blockClasses: string[]): string {
  let text = '';
  if (
    shouldCaptureElement(el, blockClasses) &&
    !isSensitiveElement(el) &&
    el.childNodes &&
    el.childNodes.length
  ) {
    el.childNodes.forEach((child) => {
      if (isTextNode(child) && child.textContent) {
        text += makeSafeText(child.textContent) ?? '';
      }
    });
  }
  return text.trim();
}

function previousElementSibling(el: Element): Element | null {
  if (el.previousElementSibling) {
    return el.previousElementSibling;
  }
  let cur: Node | null = el;
  do {
    cur = cur.previousSibling;
  } while (cur && !isElementNode(cur));
  return cur as Element | null;
}

// The per-element neutral property bag: tag_name, el_text (compatible elements only),
// classes, the attr__<name> allowlist, and the nth_child / nth_of_type position.
function propertiesForElement(el: Element, blockClasses: string[]): NeutralProperties {
  const tagName = el.tagName.toLowerCase();
  const props: NeutralProperties = { tag_name: tagName };

  if (COMPATIBLE_ELEMENTS.indexOf(tagName) > -1) {
    props.el_text = limitText(TEXT_LENGTH_CAP, getSafeText(el, blockClasses));
  }

  const classes = getClassNames(el).filter((c) => c !== '');
  if (classes.length > 0) {
    props.classes = classes;
  }

  const sensitive = isSensitiveElement(el);
  for (const attr of Array.from(el.attributes)) {
    if (sensitive && SENSITIVE_ELEMENT_SAFE_ATTRS.indexOf(attr.name) === -1) {
      continue;
    }
    if (shouldCaptureValue(attr.value) && !isAngularStyleAttr(attr.name)) {
      const value = attr.name === 'class' ? splitClassString(attr.value).join(' ') : attr.value;
      props['attr__' + attr.name] = limitText(TEXT_LENGTH_CAP, value);
    }
  }

  let nthChild = 1;
  let nthOfType = 1;
  let sibling: Element | null = el;
  while ((sibling = previousElementSibling(sibling))) {
    nthChild++;
    if (sibling.tagName === el.tagName) {
      nthOfType++;
    }
  }
  props.nth_child = nthChild;
  props.nth_of_type = nthOfType;

  return props;
}

// Serialize the elements list into the neutral elements-chain string: tag_name, then
// sorted `.class` tokens, then `:` and sorted `key="value"` attributes. De-branded from
// posthog's getElementsChainString; the wire vocabulary stays behind this neutral key.
function elementsChainString(elements: NeutralProperties[]): string {
  return elements
    .map((element) => {
      let chunk = '';
      const tagName = element.tag_name;
      if (typeof tagName === 'string') {
        chunk += tagName;
      }
      const classes = element.classes;
      if (Array.isArray(classes)) {
        for (const cls of [...classes].sort()) {
          chunk += `.${String(cls).replace(/"/g, '')}`;
        }
      }

      const attributes: Record<string, string> = {};
      const text = element.el_text;
      if (typeof text === 'string' && text) {
        attributes.text = text.slice(0, 400);
      }
      attributes['nth-child'] = String(element.nth_child ?? 0);
      attributes['nth-of-type'] = String(element.nth_of_type ?? 0);
      for (const [key, value] of Object.entries(element)) {
        if (key.indexOf('attr__') === 0) {
          attributes[key] = String(value);
        }
      }

      chunk += ':';
      chunk += Object.entries(attributes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => `${escapeQuotes(key)}="${escapeQuotes(value)}"`)
        .join('');
      return chunk;
    })
    .join(';');
}

function escapeQuotes(input: string): string {
  return input.replace(/"|\\"/g, '\\"');
}

// Resolve the deepest event target, piercing an open shadow root, and normalize a text
// node up to its parent element (Safari fires events on text nodes).
function eventTargetElement(e: Event): Element | null {
  const target = e.target;
  if (target === undefined) {
    return (e.srcElement as Element) || null;
  }
  let el: Element | null =
    (target as HTMLElement)?.shadowRoot
      ? ((e.composedPath()[0] as Element) || null)
      : ((target as Element) || null);
  if (el && isTextNode(el)) {
    el = (el.parentNode as Element | null) || null;
  }
  return el;
}

// Whether a matched CSS selector list hits the target or any ancestor — the
// ignore-for-autocapture gate (de-branded from the DEFAULT_AUTOCAPTURE_IGNORE_LIST).
function matchesIgnoreSelector(elements: Element[], selectors: string[]): boolean {
  if (selectors.length === 0) {
    return false;
  }
  return elements.some((el) => selectors.some((selector) => elementMatches(el, selector)));
}

function elementMatches(el: Element, selector: string): boolean {
  try {
    return typeof el.matches === 'function' && el.matches(selector);
  } catch {
    return false;
  }
}

interface ElementTree {
  targetElementList: Element[];
  parentIsUsefulElement: boolean;
}

// Build the target's ancestor chain up to (not including) <body>, hopping shadow-DOM
// hosts, and flag whether a compatible/pointer-styled ancestor makes this a useful
// capture target.
function buildElementTree(el: Element): ElementTree {
  const targetElementList: Element[] = [el];
  let parentIsUsefulElement = false;
  let cur: Element = el;
  while (cur.parentNode && !isTag(cur, 'body')) {
    if (isShadowRoot(cur.parentNode)) {
      targetElementList.push(cur.parentNode.host);
      cur = cur.parentNode.host;
      continue;
    }
    const parent = cur.parentNode;
    if (!isElementNode(parent)) {
      break;
    }
    if (COMPATIBLE_ELEMENTS.indexOf(parent.tagName.toLowerCase()) > -1) {
      parentIsUsefulElement = true;
    } else if (hasPointerCursor(parent)) {
      parentIsUsefulElement = true;
    }
    targetElementList.push(parent);
    cur = parent;
  }
  return { targetElementList, parentIsUsefulElement };
}

function hasPointerCursor(el: Element): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return false;
    }
    return window.getComputedStyle(el).getPropertyValue('cursor') === 'pointer';
  } catch {
    return false;
  }
}

// The event/element gating decision tree (de-branded from shouldCaptureDomEvent): an
// ignore-selector hit drops it; a pointer-styled click captures; otherwise the tag
// dictates which event types capture.
function shouldCaptureDomEvent(el: Element, event: Event, options: AutocaptureOptions): boolean {
  if (isTag(el, 'html') || !isElementNode(el)) {
    return false;
  }

  const { targetElementList, parentIsUsefulElement } = buildElementTree(el);

  if (matchesIgnoreSelector(targetElementList, options.ignoreSelectors)) {
    return false;
  }

  if (event.type === 'click' && hasPointerCursor(el)) {
    return true;
  }

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'html':
      return false;
    case 'form':
      return event.type === 'submit';
    case 'input':
    case 'select':
    case 'textarea':
      return event.type === 'change' || event.type === 'click';
    default:
      if (parentIsUsefulElement) {
        return event.type === 'click';
      }
      return (
        event.type === 'click' &&
        (COMPATIBLE_ELEMENTS.indexOf(tag) > -1 || el.getAttribute('contenteditable') === 'true')
      );
  }
}

// The neutral autocapture property bag for one target: event_type, the per-element
// chain, the elements_chain string, el_text, and the href allowlist. Returns undefined
// when the event should not be captured or a block class suppresses it.
export function autocapturePropertiesForEvent(
  event: Event,
  options: AutocaptureOptions
): NeutralProperties | undefined {
  const target = eventTargetElement(event);
  if (!target || !isElementNode(target)) {
    return undefined;
  }
  if (!shouldCaptureDomEvent(target, event, options)) {
    return undefined;
  }

  const { targetElementList } = buildElementTree(target);

  const elementsJson: NeutralProperties[] = [];
  let href: string | undefined;
  for (const el of targetElementList) {
    const capturable = shouldCaptureElement(el, options.blockClasses);
    if (isTag(el, 'a')) {
      const hrefAttr = el.getAttribute('href');
      if (capturable && hrefAttr && shouldCaptureValue(hrefAttr)) {
        href = hrefAttr;
      }
    }
    if (getClassNames(el).some((c) => options.blockClasses.includes(c))) {
      return undefined;
    }
    elementsJson.push(propertiesForElement(el, options.blockClasses));
  }

  const first = elementsJson[0];
  if (first !== undefined) {
    first.el_text = getSafeText(target, options.blockClasses);
    if (href !== undefined) {
      first.attr__href = href;
    }
  }

  const props: NeutralProperties = {
    event_type: event.type,
    elements_chain: elementsChainString(elementsJson),
  };
  const firstText = first?.el_text;
  if (typeof firstText === 'string' && firstText) {
    props.el_text = firstText;
  }
  return props;
}

// The three capture-phase document listeners. Guarded for the non-DOM/SSR context
// exactly as the adapter's unload-listener binding is; returns an unbinder, or undefined
// when there is no document to bind to. NO remote-config gate — binding happens purely
// because the caller opted in via the local `autocapture` config boolean.
export function bindAutocaptureListeners(
  onEvent: (props: NeutralProperties) => void,
  options: AutocaptureOptions = defaultAutocaptureOptions()
): (() => void) | undefined {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return undefined;
  }
  const doc = document;
  const handler = (event: Event): void => {
    const props = autocapturePropertiesForEvent(event, options);
    if (props !== undefined) {
      onEvent(props);
    }
  };
  doc.addEventListener('submit', handler, true);
  doc.addEventListener('change', handler, true);
  doc.addEventListener('click', handler, true);
  return () => {
    doc.removeEventListener('submit', handler, true);
    doc.removeEventListener('change', handler, true);
    doc.removeEventListener('click', handler, true);
  };
}
