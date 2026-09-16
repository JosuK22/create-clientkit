/**
 * A titled band of content.
 *
 * The only shared component the full starter needs: it owns the container and
 * the optional heading so the page above reads as structure rather than as
 * markup. A server component, like everything else here.
 */
export function Section({
  heading,
  className,
  children,
}: {
  heading?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={className}>
      <div className="container stack">
        {heading ? <h2>{heading}</h2> : null}
        {children}
      </div>
    </section>
  );
}
