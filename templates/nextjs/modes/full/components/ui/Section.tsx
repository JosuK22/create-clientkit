/**
 * One titled section of the home page.
 *
 * The heading is linked to its section with `aria-labelledby` rather than left
 * to proximity, so the landmark has an accessible name a screen reader can
 * announce. A server component, like everything else here.
 */
export function Section({ id, title, body }: { id: string; title: string; body: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`} className="section-title">
        {title}
      </h2>
      <p className="section-body">{body}</p>
    </section>
  );
}
