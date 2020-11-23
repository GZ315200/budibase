import { get, writable } from "svelte/store"
import { cloneDeep } from "lodash/fp"
import {
  createProps,
  getBuiltin,
  makePropsSafe,
} from "components/userInterface/pagesParsing/createProps"
import { allScreens, backendUiStore, selectedPage } from "builderStore"
import { generate_screen_css } from "../generate_css"
import { fetchComponentLibDefinitions } from "../loadComponentLibraries"
import api from "../api"
import { DEFAULT_PAGES_OBJECT } from "../../constants"
import getNewComponentName from "../getNewComponentName"
import analytics from "analytics"
import {
  findChildComponentType,
  generateNewIdsForComponent,
  getComponentDefinition,
  getParent,
} from "../storeUtils"

const INITIAL_FRONTEND_STATE = {
  apps: [],
  name: "",
  description: "",
  pages: DEFAULT_PAGES_OBJECT,
  mainUi: {},
  unauthenticatedUi: {},
  components: [],
  currentPreviewItem: null,
  currentComponentInfo: null,
  currentFrontEndType: "none",
  currentPageName: "",
  currentComponentProps: null,
  errors: [],
  hasAppPackage: false,
  libraries: null,
  appId: "",
  routes: {},
}

export const getFrontendStore = () => {
  const store = writable({ ...INITIAL_FRONTEND_STATE })

  store.actions = {
    // TODO: REFACTOR
    initialise: async pkg => {
      store.update(state => {
        state.appId = pkg.application._id
        return state
      })
      const screens = await api.get("/api/screens").then(r => r.json())

      const mainScreens = screens.filter(screen =>
          screen._id.includes(pkg.pages.main._id)
        ),
        unauthScreens = screens.filter(screen =>
          screen._id.includes(pkg.pages.unauthenticated._id)
        )
      pkg.pages = {
        main: {
          ...pkg.pages.main,
          _screens: mainScreens,
        },
        unauthenticated: {
          ...pkg.pages.unauthenticated,
          _screens: unauthScreens,
        },
      }

      // if the app has just been created
      // we need to build the CSS and save
      if (pkg.justCreated) {
        for (let pageName of ["main", "unauthenticated"]) {
          const page = pkg.pages[pageName]
          store.actions.screens.regenerateCss(page)
          for (let screen of page._screens) {
            store.actions.screens.regenerateCss(screen)
          }

          await api.post(`/api/pages/${page._id}`, {
            page: {
              componentLibraries: pkg.application.componentLibraries,
              ...page,
            },
            screens: page._screens,
          })
        }
      }

      pkg.justCreated = false

      const components = await fetchComponentLibDefinitions(pkg.application._id)

      store.update(state => ({
        ...state,
        libraries: pkg.application.componentLibraries,
        components,
        name: pkg.application.name,
        description: pkg.application.description,
        appId: pkg.application._id,
        pages: pkg.pages,
        hasAppPackage: true,
        builtins: [getBuiltin("##builtin/screenslot")],
        appInstance: pkg.application.instance,
      }))

      await backendUiStore.actions.database.select(pkg.application.instance)
    },
    selectPageOrScreen: type => {
      store.update(state => {
        state.currentFrontEndType = type

        const page = get(selectedPage)

        const pageOrScreen = type === "page" ? page : page._screens[0]

        state.currentComponentInfo = pageOrScreen ? pageOrScreen.props : null
        state.currentPreviewItem = pageOrScreen
        state.currentView = "detail"
        return state
      })
    },
    routing: {
      fetch: async () => {
        const response = await api.get("/api/routing")
        const json = await response.json()

        store.update(state => {
          state.routes = json.routes
          return state
        })
      },
    },
    screens: {
      select: screenId => {
        store.update(state => {
          const screen = get(allScreens).find(screen => screen._id === screenId)
          state.currentPreviewItem = screen
          state.currentFrontEndType = "screen"
          state.currentView = "detail"

          store.actions.screens.regenerateCssForCurrentScreen()
          const safeProps = makePropsSafe(
            state.components[screen.props._component],
            screen.props
          )
          screen.props = safeProps
          state.currentComponentInfo = safeProps
          return state
        })
      },
      create: async screen => {
        let savePromise
        store.update(state => {
          state.currentPreviewItem = screen
          state.currentComponentInfo = screen.props
          state.currentFrontEndType = "screen"

          if (state.currentPreviewItem) {
            store.actions.screens.regenerateCss(state.currentPreviewItem)
          }

          savePromise = store.actions.screens.save(screen)
          return state
        })

        await savePromise
      },
      save: async screen => {
        const page = get(selectedPage)
        const currentPageScreens = page._screens

        const creatingNewScreen = screen._id === undefined

        let savePromise
        const response = await api.post(`/api/screens/${page._id}`, screen)
        const json = await response.json()
        screen._rev = json.rev
        screen._id = json.id
        const foundScreen = page._screens.findIndex(el => el._id === screen._id)
        if (foundScreen !== -1) {
          page._screens.splice(foundScreen, 1)
        }
        page._screens.push(screen)

        // TODO: should carry out all server updates to screen in a single call
        store.update(state => {
          page._screens = currentPageScreens

          if (creatingNewScreen) {
            state.currentPreviewItem = screen
            const safeProps = makePropsSafe(
              state.components[screen.props._component],
              screen.props
            )
            state.currentComponentInfo = safeProps
            screen.props = safeProps
          }
          savePromise = store.actions.pages.save()

          return state
        })
        if (savePromise) await savePromise
      },
      regenerateCss: screen => {
        screen._css = generate_screen_css([screen.props])
      },
      regenerateCssForCurrentScreen: () => {
        const { currentPreviewItem } = get(store)
        if (currentPreviewItem) {
          store.actions.screens.regenerateCss(currentPreviewItem)
        }
      },
      delete: async screens => {
        let deletePromise

        const screensToDelete = Array.isArray(screens) ? screens : [screens]

        store.update(state => {
          const currentPage = get(selectedPage)

          for (let screenToDelete of screensToDelete) {
            // Remove screen from current page as well
            // TODO: Should be done server side
            currentPage._screens = currentPage._screens.filter(
              scr => scr._id !== screenToDelete._id
            )

            deletePromise = api.delete(
              `/api/screens/${screenToDelete._id}/${screenToDelete._rev}`
            )
          }
          return state
        })
        await deletePromise
      },
    },
    preview: {
      saveSelected: async () => {
        const state = get(store)
        if (state.currentFrontEndType !== "page") {
          await store.actions.screens.save(state.currentPreviewItem)
        }
        await store.actions.pages.save()
      },
    },
    pages: {
      select: pageName => {
        store.update(state => {
          const currentPage = state.pages[pageName]

          state.currentFrontEndType = "page"
          state.currentView = "detail"
          state.currentPageName = pageName

          // This is the root of many problems.
          // Uncaught (in promise) TypeError: Cannot read property '_component' of undefined
          // it appears that the currentPage sometimes has _props instead of props
          // why
          const safeProps = makePropsSafe(
            state.components[currentPage.props._component],
            currentPage.props
          )
          state.currentComponentInfo = safeProps
          currentPage.props = safeProps
          state.currentPreviewItem = state.pages[pageName]
          store.actions.screens.regenerateCssForCurrentScreen()

          for (let screen of get(allScreens)) {
            screen._css = generate_screen_css([screen.props])
          }

          return state
        })
      },
      save: async page => {
        const storeContents = get(store)
        const pageName = storeContents.currentPageName || "main"
        const pageToSave = page || storeContents.pages[pageName]

        // TODO: revisit. This sends down a very weird payload
        const response = await api.post(`/api/pages/${pageToSave._id}`, {
          page: {
            componentLibraries: storeContents.pages.componentLibraries,
            ...pageToSave,
          },
          screens: pageToSave._screens,
        })

        const json = await response.json()

        if (!json.ok) throw new Error("Error updating page")

        store.update(state => {
          state.pages[pageName]._rev = json.rev
          return state
        })
      },
    },
    components: {
      select: component => {
        store.update(state => {
          const componentDef = component._component.startsWith("##")
            ? component
            : state.components[component._component]
          state.currentComponentInfo = makePropsSafe(componentDef, component)
          state.currentView = "component"
          return state
        })
      },
      create: (componentToAdd, presetProps) => {
        store.update(state => {
          function findSlot(component_array) {
            for (let component of component_array) {
              if (component._component === "##builtin/screenslot") {
                return true
              }

              if (component._children) findSlot(component)
            }
            return false
          }

          if (
            componentToAdd.startsWith("##") &&
            findSlot(state.pages[state.currentPageName].props._children)
          ) {
            return state
          }

          const component = getComponentDefinition(state, componentToAdd)

          const instanceId = get(backendUiStore).selectedDatabase._id
          const instanceName = getNewComponentName(component, state)

          const newComponent = createProps(component, {
            ...presetProps,
            _instanceId: instanceId,
            _instanceName: instanceName,
          })

          const currentComponent =
            state.components[state.currentComponentInfo._component]

          const targetParent = currentComponent.children
            ? state.currentComponentInfo
            : getParent(
                state.currentPreviewItem.props,
                state.currentComponentInfo
              )

          // Don't continue if there's no parent
          if (!targetParent) {
            return state
          }

          targetParent._children = targetParent._children.concat(
            newComponent.props
          )

          store.actions.preview.saveSelected()

          state.currentView = "component"
          state.currentComponentInfo = newComponent.props
          analytics.captureEvent("Added Component", {
            name: newComponent.props._component,
          })
          return state
        })
      },
      copy: (component, cut = false) => {
        store.update(state => {
          state.componentToPaste = cloneDeep(component)
          state.componentToPaste.isCut = cut
          if (cut) {
            const parent = getParent(
              state.currentPreviewItem.props,
              component._id
            )
            parent._children = parent._children.filter(
              child => child._id !== component._id
            )
            store.actions.components.select(parent)
          }

          return state
        })
      },
      paste: (targetComponent, mode) => {
        store.update(state => {
          if (!state.componentToPaste) return state

          const componentToPaste = cloneDeep(state.componentToPaste)
          // retain the same ids as things may be referencing this component
          if (componentToPaste.isCut) {
            // in case we paste a second time
            state.componentToPaste.isCut = false
          } else {
            generateNewIdsForComponent(componentToPaste, state)
          }
          delete componentToPaste.isCut

          if (mode === "inside") {
            targetComponent._children.push(componentToPaste)
            return state
          }

          const parent = getParent(
            state.currentPreviewItem.props,
            targetComponent
          )

          const targetIndex = parent._children.indexOf(targetComponent)
          const index = mode === "above" ? targetIndex : targetIndex + 1
          parent._children.splice(index, 0, cloneDeep(componentToPaste))

          store.actions.screens.regenerateCssForCurrentScreen()
          store.actions.preview.saveSelected()
          store.actions.components.select(componentToPaste)

          return state
        })
      },
      updateStyle: (type, name, value) => {
        store.update(state => {
          if (!state.currentComponentInfo._styles) {
            state.currentComponentInfo._styles = {}
          }
          state.currentComponentInfo._styles[type][name] = value

          store.actions.screens.regenerateCssForCurrentScreen()

          // save without messing with the store
          store.actions.preview.saveSelected()
          return state
        })
      },
      updateProp: (name, value) => {
        store.update(state => {
          let current_component = state.currentComponentInfo
          current_component[name] = value

          state.currentComponentInfo = current_component
          store.actions.preview.saveSelected()
          return state
        })
      },
      findRoute: component => {
        // Gets all the components to needed to construct a path.
        const tempStore = get(store)
        let pathComponents = []
        let parent = component
        let root = false
        while (!root) {
          parent = getParent(tempStore.currentPreviewItem.props, parent)
          if (!parent) {
            root = true
          } else {
            pathComponents.push(parent)
          }
        }

        // Remove root entry since it's the screen or page layout.
        // Reverse array since we need the correct order of the IDs
        const reversedComponents = pathComponents.reverse().slice(1)

        // Add component
        const allComponents = [...reversedComponents, component]

        // Map IDs
        const IdList = allComponents.map(c => c._id)

        // Construct ID Path:
        return IdList.join("/")
      },
      links: {
        save: async (url, title) => {
          let savePromise
          store.update(state => {
            // Try to extract a nav component from the master screen
            const nav = findChildComponentType(
              state.pages.main,
              "@budibase/standard-components/Navigation"
            )
            if (nav) {
              let newLink

              // Clone an existing link if one exists
              if (nav._children && nav._children.length) {
                // Clone existing link style
                newLink = cloneDeep(nav._children[0])

                // Manipulate IDs to ensure uniqueness
                generateNewIdsForComponent(newLink, state, false)

                // Set our new props
                newLink._instanceName = `${title} Link`
                newLink.url = url
                newLink.text = title
              } else {
                // Otherwise create vanilla new link
                const component = getComponentDefinition(
                  state,
                  "@budibase/standard-components/link"
                )
                const instanceId = get(backendUiStore).selectedDatabase._id
                newLink = createProps(component, {
                  url,
                  text: title,
                  _instanceName: `${title} Link`,
                  _instanceId: instanceId,
                }).props
              }

              // Save page and regenerate all CSS because otherwise weird things happen
              nav._children = [...nav._children, newLink]
              state.currentPageName = "main"
              store.actions.screens.regenerateCss(state.pages.main)
              for (let screen of state.pages.main._screens) {
                store.actions.screens.regenerateCss(screen)
              }
              savePromise = store.actions.pages.save()
            }
            return state
          })
          await savePromise
        },
      },
    },
  }

  return store
}