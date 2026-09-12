import { Brand } from '../common/Brand';
import { Container } from '../ui/Container';
import { NAV } from '../../config/site.config';

/**
 * Site header.
 *
 * The menu is omitted entirely when NAV is empty - a bar containing one logo
 * that links nowhere is worse than no bar.
 */
export function Header() {
  const links = NAV.filter((item) => item.label !== '' && item.href !== '');

  return (
    <header className="site-header">
      <Container className="site-header-inner">
        <Brand />

        {links.length > 0 && (
          <nav aria-label="Primary">
            <ul className="site-nav">
              {links.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className="site-nav-link">
                    {item.label}
                  </a>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </Container>
    </header>
  );
}
