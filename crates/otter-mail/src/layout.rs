//! Fixed side panes; the reader takes the remaining width, as in the original app.

#[derive(Clone, Copy, Debug)]
pub enum Pane {
    Sidebar,
    List,
    Browser,
}

#[derive(Clone, Copy, Debug)]
pub struct PaneWidths {
    pub sidebar: f32,
    pub list: f32,
    pub browser: f32,
}

const READER_MIN: f32 = 360.;

impl PaneWidths {
    pub fn fit(self, available: f32, sidebar_open: bool, browser_open: bool) -> Self {
        let mut sizes = Self {
            sidebar: if sidebar_open { self.sidebar } else { 0. },
            list: self.list,
            browser: if browser_open { self.browser } else { 0. },
        };
        let mut excess =
            (sizes.sidebar + sizes.list + sizes.browser + READER_MIN - available).max(0.);
        for (size, min) in [
            (&mut sizes.browser, if browser_open { 280. } else { 0. }),
            (&mut sizes.list, 280.),
            (&mut sizes.sidebar, if sidebar_open { 180. } else { 0. }),
        ] {
            let reduction = excess.min((*size - min).max(0.));
            *size -= reduction;
            excess -= reduction;
        }
        sizes
    }

    /// Only the dragged pane changes. Its growth consumes the reader's space.
    pub fn drag(self, pane: Pane, delta: f32, available: f32) -> Self {
        let mut sizes = self;
        let reader = (available - self.sidebar - self.list - self.browser).max(0.);
        let room = (reader - READER_MIN).max(0.);
        let (size, min, max, delta): (&mut f32, f32, f32, f32) = match pane {
            Pane::Sidebar => (&mut sizes.sidebar, 180., 400., delta),
            Pane::List => (&mut sizes.list, 280., 640., delta),
            Pane::Browser => (&mut sizes.browser, 280., 1200., -delta),
        };
        *size = (*size + delta).clamp(min, max.min(*size + room).max(min));
        sizes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const WIDTHS: PaneWidths = PaneWidths {
        sidebar: 200.,
        list: 340.,
        browser: 340.,
    };

    #[test]
    fn browser_drag_keeps_mail_panes_fixed_and_leaves_room_to_read() {
        let sizes = WIDTHS.drag(Pane::Browser, -900., 1542.);
        assert_eq!(
            (sizes.sidebar, sizes.list, sizes.browser),
            (200., 340., 642.)
        );
        assert_eq!(
            1542. - sizes.sidebar - sizes.list - sizes.browser,
            READER_MIN
        );
        let shrunk = sizes.drag(Pane::Browser, 100., 1542.);
        assert_eq!(
            (shrunk.sidebar, shrunk.list, shrunk.browser),
            (200., 340., 542.)
        );
    }

    #[test]
    fn list_and_sidebar_drag_do_not_resize_the_browser() {
        let sizes = WIDTHS
            .drag(Pane::List, 80., 1542.)
            .drag(Pane::Sidebar, 20., 1542.);
        assert_eq!(
            (sizes.sidebar, sizes.list, sizes.browser),
            (220., 420., 340.)
        );
    }

    #[test]
    fn window_and_visibility_changes_preserve_preferred_widths() {
        let small = WIDTHS.fit(1100., true, true);
        assert_eq!(
            (small.sidebar, small.list, small.browser),
            (180., 280., 280.)
        );
        let large = WIDTHS.fit(2000., true, true);
        assert_eq!(
            (large.sidebar, large.list, large.browser),
            (200., 340., 340.)
        );
        let closed = WIDTHS.fit(1542., true, false);
        assert_eq!(
            (closed.sidebar, closed.list, closed.browser),
            (200., 340., 0.)
        );
    }
}
