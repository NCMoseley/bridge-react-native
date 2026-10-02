// Smooth-scroll an element to a fraction below the viewport top (default 10%),
// so linked targets aren't pinned flush against the top edge.
export function scrollToElement(el: Element, offsetFraction = 0.1) {
  const top =
    el.getBoundingClientRect().top + window.scrollY - window.innerHeight * offsetFraction
  window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}
