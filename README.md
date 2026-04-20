# ShelfAware 

## Structure

**SHOULD BE UPDATED AS PROJECT PROGRESSES**

```
ShelfAware/
├ src/
│ ├ lib/
│ │ ├ assets/
│ │ └ [your lib files]
│ ├ routes/
│ │ └ [your routes]
│ └ app.html
├ static/
│ └ [your static assets]
├ tests/
│ └ [your tests]
├ .prettierignore
├ package.json
├ package-lock.json
├ svelte.config.js
├ tsconfig.json
└ vite.config.js
```

## Quick start

Once you've cloned the project and installed dependencies with `npm install`, start a development server:

```sh
npm run dev

# or start the server and open the app in a new browser tab
npm run dev -- --open
```

To recreate this project with the same configuration:

```sh
# recreate this project
npx sv@0.15.1 create --template minimal --types ts --install npm ./
```

## Building

To create a production version of the app:

```sh
npm run build
```

You can preview the production build with `npm run preview`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, workflow, and team guides.
