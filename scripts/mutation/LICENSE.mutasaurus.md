# Mutasaurus attribution

The mutation-operator tables in `operators.ts` and the binary/assignment
expression walking strategy in `generate.ts` are derived from Mutasaurus
(`@mutasaurus/mutasaurus`, https://github.com/christoshrousis/mutasaurus),
used here under the MIT licence reproduced below.

Our runner intentionally diverges from upstream in one critical place: upstream
writes each mutated file into a temporary working directory but then runs the
*original* test files, which (in a project that imports source through import
map aliases such as `#shared/...`) resolve back to the unmutated source — so
every mutant survives. Our runner mutates the source file in place, runs the
mapped tests, and restores it, so mutations actually bind through the aliases.

---

MIT License

Copyright (c) Christos Hrousis

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
</invoke>
