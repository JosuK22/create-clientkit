# Third-party notices

`create-clientkit` publishes with `dependencies: {}`. The libraries below are
bundled into `dist/cli.js` at build time so that `npm create clientkit@latest`
costs the user a single tarball download and no dependency resolution.

Their licenses and copyright notices are reproduced here as required.

| Package                                                    | Version | License | Copyright       |
| ---------------------------------------------------------- | ------- | ------- | --------------- |
| [@clack/prompts](https://github.com/bombshell-dev/clack)   | 0.11.0  | MIT     | Nate Moore      |
| [@clack/core](https://github.com/bombshell-dev/clack)      | 0.5.0   | MIT     | Nate Moore      |
| [sisteransi](https://github.com/terkelg/sisteransi)        | 1.0.5   | MIT     | Terkel Gjervig  |
| [picocolors](https://github.com/alexeyraspopov/picocolors) | 1.1.1   | ISC     | Alexey Raspopov |

## MIT License

Applies to `@clack/prompts`, `@clack/core` and `sisteransi`.

```
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## ISC License

Applies to `picocolors`.

```
Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
```

> **Maintenance note (technical debt):** this file is currently written by hand.
> It should be generated from the dependency tree during `npm run build` before
> the first publish, so it cannot drift.
