import {Location} from '@angular/common';
import {PlatformNavigation} from '@angular/common/src/navigation/platform_navigation';
import {EventEmitter, inject, Injectable} from '@angular/core';
import {SubscriptionLike} from 'rxjs';

import {BeforeActivateRoutes, NavigationCancel, NavigationCancellationCode, NavigationEnd, NavigationError, NavigationSkipped, NavigationStart, PrivateRouterEvents, RoutesRecognized} from '../events';
import {Navigation, RestoredState} from '../navigation_transition';
import {ROUTER_CONFIGURATION} from '../router_config';
import {createEmptyState, RouterState} from '../router_state';
import {UrlHandlingStrategy} from '../url_handling_strategy';
import {UrlSerializer, UrlTree} from '../url_tree';

import {StateManager} from './state_manager';

interface NavigationInfo {
  intercept?: boolean;
  focusReset?: 'after-transition'|'manual';
  scroll?: 'after-transition'|'manual';
  deferredCommit?: boolean;
  transition?: Navigation;
  rollback?: boolean;
}

/**
 * @internal
 */
@Injectable({providedIn: 'root'})
export class NavigationStateManager extends StateManager {
  private readonly urlSerializer = inject(UrlSerializer);
  private readonly options = inject(ROUTER_CONFIGURATION, {optional: true}) || {};
  private readonly canceledNavigationResolution =
      this.options.canceledNavigationResolution || 'replace';

  private location = inject(Location);
  private navigation = inject(PlatformNavigation);
  private urlHandlingStrategy = inject(UrlHandlingStrategy);
  private urlUpdateStrategy = this.options.urlUpdateStrategy || 'deferred';

  private currentUrlTree = new UrlTree();

  override getCurrentUrlTree(): UrlTree {
    return this.currentUrlTree;
  }

  private rawUrlTree = this.currentUrlTree;

  override getRawUrlTree(): UrlTree {
    return this.rawUrlTree;
  }

  /**
   * The NavigationHistoryEntry for the active state. This enables restoring history if an ongoing
   * navigation cancels.
   */
  private activeHistoryEntry: NavigationHistoryEntry = this.navigation.currentEntry!;

  override restoredState(): RestoredState|null|undefined {
    return this.navigation.currentEntry!.getState() as RestoredState | null | undefined;
  }

  private routerState = createEmptyState(this.currentUrlTree, null);

  override getRouterState(): RouterState {
    return this.routerState;
  }

  private stateMemento = this.createStateMemento();

  private nonRouterCurrentEntryChangeSubject =
      new EventEmitter<NavigationCurrentEntryChangeEvent>();

  private info?: NavigationInfo;

  constructor() {
    super();
    if (this.canceledNavigationResolution !== 'computed') {
      throw new Error(
          'Navigation API-based router only supports `computed` canceledNavigationResolution.');
    }

    this.navigation.addEventListener('navigate', (event) => {
      this.handleNavigate(event);
    });

    this.navigation.addEventListener('currententrychange', (event) => {
      this.handleCurrentEntryChange(event);
    });
  }

  override registerNonRouterCurrentEntryChangeListener(
      listener: (url: string, state: RestoredState|null|undefined) => void): SubscriptionLike {
    return this.nonRouterCurrentEntryChangeSubject.subscribe(() => {
      const currentEntry = this.navigation.currentEntry!;
      listener(currentEntry.url!, currentEntry.getState() as RestoredState | null | undefined);
    });
  }

  override handleRouterEvent(e: Event|PrivateRouterEvents, transition: Navigation): void {
    if (e instanceof NavigationStart) {
      this.stateMemento = this.createStateMemento();
    } else if (e instanceof NavigationSkipped) {
      this.rawUrlTree = transition.initialUrl;
    } else if (e instanceof RoutesRecognized) {
      if (!transition.extras.skipLocationChange) {
        const rawUrl = this.urlHandlingStrategy.merge(transition.finalUrl!, transition.initialUrl);
        this.navigate(rawUrl, transition, this.urlUpdateStrategy === 'deferred');
      }
    } else if (e instanceof BeforeActivateRoutes) {
      // Commit URL for `urlUpdateStrategy === 'deferred'`.
      transition.commitUrl?.();
    } else if (
        e instanceof NavigationCancel &&
        (e.code === NavigationCancellationCode.GuardRejected ||
         e.code === NavigationCancellationCode.NoDataFromResolver)) {
      this.cancel(transition);
    } else if (e instanceof NavigationError) {
      this.cancel(transition, /* restoringFromCaughtError= */ true);
    } else if (e instanceof NavigationEnd) {
      this.activeHistoryEntry = this.navigation.currentEntry!;
    }
  }

  private navigate(rawUrl: UrlTree, transition: Navigation, deferredCommit = false) {
    const path = this.urlSerializer.serialize(rawUrl);
    const state = {
      ...transition.extras.state,
    };
    const history = this.location.isCurrentPathEqualTo(path) && transition.extras.replaceUrl ?
        'replace' :
        'push';
    const info: NavigationInfo = {
      intercept: true,
      focusReset: 'manual',
      deferredCommit,
      transition,
    };
    this.navigation.navigate(path, {state, history, info});
  }

  private cancel(transition: Navigation, restoringFromCaughtError = false) {
    transition.cancel?.();
    if (this.navigation.currentEntry!.id !== this.activeHistoryEntry.id) {
      if (this.navigation.currentEntry!.key !== this.activeHistoryEntry.key) {
        this.navigation.traverseTo(this.activeHistoryEntry.key, {info: 'rollback'});
      } else {
        // We got to the activation stage (where currentUrlTree is set to the navigation's
        // finalUrl), but we weren't moving anywhere in history (skipLocationChange or
        // replaceUrl). We still need to reset the router state back to what it was when the
        // navigation started.
        this.resetInternalState(transition);
        this.navigation.navigate(
            this.urlSerializer.serialize(this.rawUrlTree),
            {state: this.activeHistoryEntry.getState(), history: 'replace', info: 'rollback'});
      }
    }
  }

  private handleNavigate(event: NavigateEvent) {
    const info = event.info as NavigationInfo | undefined;
    this.info = info;

    const intercept = info?.intercept;
    if (event.canIntercept && intercept) {
      const interceptOptions: NavigationInterceptOptions = {
        focusReset: info.focusReset,
        scroll: info.scroll,
        // Resolved when the `transition.finish()` is called.
        handler: () => new Promise<void>((resolve, reject) => {
          info.transition!.finish = resolve;
          info.transition!.cancel = reject;
        }),
      };
      if (info.deferredCommit) {
        (interceptOptions as any).commit = 'after-transition';
        // Defer commit until `transition.commitUrl` is called.
        info.transition!.commitUrl = () => {
          (event as any).commit();
        };
      }
      event.intercept(interceptOptions);
      return;
    }
  }

  private handleCurrentEntryChange(event: NavigationCurrentEntryChangeEvent) {
    const info = this.info;
    if (!info) {
      this.nonRouterCurrentEntryChangeSubject.emit(event);
      return;
    }
    if (info.rollback) {
      this.activeHistoryEntry = this.navigation.currentEntry!;
    }
  }

  private createStateMemento() {
    return {
      rawUrlTree: this.rawUrlTree,
      currentUrlTree: this.currentUrlTree,
      routerState: this.routerState,
    };
  }

  private resetInternalState(navigation: Navigation): void {
    this.routerState = this.stateMemento.routerState;
    this.currentUrlTree = this.stateMemento.currentUrlTree;
    // Note here that we use the urlHandlingStrategy to get the reset `rawUrlTree` because it may be
    // configured to handle only part of the navigation URL. This means we would only want to reset
    // the part of the navigation handled by the Angular router rather than the whole URL. In
    // addition, the URLHandlingStrategy may be configured to specifically preserve parts of the URL
    // when merging, such as the query params so they are not lost on a refresh.
    this.rawUrlTree =
        this.urlHandlingStrategy.merge(this.currentUrlTree, navigation.finalUrl ?? this.rawUrlTree);
  }
}
