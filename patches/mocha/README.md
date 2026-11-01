# Mocha 10.8.2 compatibility backport

Source: [Mocha 10.8.2 registry archive](https://registry.npmjs.org/mocha/-/mocha-10.8.2.tgz) (MIT). Registry integrity: `sha512-VZlYo/WE8t1tstuRmqgeyBgCbJc/lEdopaa+axcKzTBJ+UIdlAB9XnmvTCAH4pwR4ElNInaedhEBmZD8iCSVEg==`.

The source in `vendor/mocha` retains Mocha's name and version. `backport.patch` pins minimatch 11.0.1 and updates its CommonJS import. The tarball is generated with `npm pack ./vendor/mocha --ignore-scripts --pack-destination ./patches/mocha`. Verify the archive, source and exact changes with `python patches/mocha/verify-source.py <original-mocha-10.8.2.tgz>`. Run `node patches/mocha/regression.cjs <installed-mocha-directory>` after installing the tarball and its dependencies. The regression tests the actual collector and preserved `handleRequires` export.

The root lockfile must separately pin the selected transitive dependency closure. The original Mocha MIT license is retained in the source and package.
