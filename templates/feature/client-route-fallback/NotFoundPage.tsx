import { Container } from '../components/ui/Container';
import { BaseLayout } from '../layouts/BaseLayout';

/**
 * What renders when the router matches nothing.
 *
 * ## Read this before treating it as a 404
 *
 * This is a component, not a response. By the time it renders, your host has
 * already answered the request - almost always with `200 OK` for `index.html`,
 * because that is the file a single-page application asks the host to serve for
 * every address. Nothing React does afterwards can change a status line that
 * has already been sent.
 *
 * So: a visitor sees a helpful page. A crawler, an uptime monitor, a link
 * checker and your CDN logs all see a successful request for a page that does
 * not exist. That gap has a name - a soft 404 - and search engines treat it as
 * a defect.
 *
 * If you need a real one, it has to come from somewhere that runs before the
 * response: a rewrite rule or error page in your host's configuration, or a
 * framework that renders on the server. Both are outside what this project
 * generates. The README says the same thing at more length.
 *
 * ## Why there is no title here
 *
 * You might expect `useDocumentMeta('Page not found', ...)`, and the hook is
 * right there if you want it. It was left out on purpose: announcing "Page not
 * found" in the title of a document the server returned as `200` is precisely
 * the signal that makes a soft 404 worse rather than better. Add it once your
 * host returns a status that agrees with it.
 */
export function NotFoundPage() {
  return (
    <BaseLayout>
      <Container className="hero">
        <div className="hero-inner">
          <p className="eyebrow">Not found</p>

          <h1 className="page-title">This page does not exist</h1>

          <p className="lead">
            The address you followed does not match anything on this site. It may have moved, or the
            link may have been mistyped.
          </p>

          {/*
            A plain anchor rather than the router's own link component, and that
            is deliberate. This file is contributed by a feature that requires
            client-side routing in general, not React Router in particular, so
            it names no router package - swap the router and this page still
            works. The cost is a real page load on click, which on the way back
            to a page that exists is no cost at all.
          */}
          <a href="/" className="button-primary">
            Back to home
          </a>
        </div>
      </Container>
    </BaseLayout>
  );
}
