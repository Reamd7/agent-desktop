use crate::actions::chain_delivery::DeliveryOutcome;

/// `AXPress` on a row or a cell means "select me", and a grid that is not the
/// key view accepts it, answers `kAXErrorSuccess`, and selects nothing. The
/// responder is not lying about reaching the application, only about what
/// happened there, so reading the selection back is what tells the two apart.
/// A selection that is still false is evidence of a delivery with no effect,
/// which is the one result that lets the chain go on to write the container's
/// selection instead of reporting a success the caller cannot see. An element
/// that publishes no selection at all is unchanged: absence of evidence stops
/// the chain exactly as it does today.
fn outcome_from_selection(pressed: DeliveryOutcome, selected: Option<bool>) -> DeliveryOutcome {
    if pressed != DeliveryOutcome::DeliveredUnverified {
        return pressed;
    }
    match selected {
        Some(true) => DeliveryOutcome::DeliveredVerified,
        Some(false) => DeliveryOutcome::DeliveredWithoutEffect,
        None => pressed,
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use super::outcome_from_selection;
    use crate::actions::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    pub(crate) fn press_or_report_no_effect(
        element: &AXElement,
        deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        let pressed =
            crate::actions::ax_helpers::perform_observed_action(element, "AXPress", deadline)?;
        if pressed != DeliveryOutcome::DeliveredUnverified {
            return Ok(pressed);
        }
        Ok(outcome_from_selection(
            pressed,
            selection_after_press(element, deadline),
        ))
    }

    fn selection_after_press(element: &AXElement, deadline: Deadline) -> Option<bool> {
        if !crate::actions::container_select::element_activates_by_selection(element, deadline) {
            return None;
        }
        crate::tree::attributes::copy_bool_attr_result(
            element,
            crate::actions::container_select::SELECTED,
            deadline,
        )
        .ok()
        .flatten()
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use agent_desktop_core::{AdapterError, Deadline};

    use crate::actions::chain_delivery::DeliveryOutcome;
    use crate::tree::AXElement;

    pub(crate) fn press_or_report_no_effect(
        _element: &AXElement,
        _deadline: Deadline,
    ) -> Result<DeliveryOutcome, AdapterError> {
        Ok(DeliveryOutcome::NotDelivered)
    }
}

pub(crate) use imp::press_or_report_no_effect;

#[cfg(test)]
mod tests {
    use super::{DeliveryOutcome, outcome_from_selection};

    #[test]
    fn a_press_that_left_the_selection_false_is_a_delivery_without_effect() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, Some(false)),
            DeliveryOutcome::DeliveredWithoutEffect
        );
    }

    #[test]
    fn a_press_that_selected_the_target_is_verified_rather_than_merely_delivered() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, Some(true)),
            DeliveryOutcome::DeliveredVerified
        );
    }

    #[test]
    fn an_element_without_a_selection_keeps_todays_unverified_delivery() {
        assert_eq!(
            outcome_from_selection(DeliveryOutcome::DeliveredUnverified, None),
            DeliveryOutcome::DeliveredUnverified
        );
    }

    #[test]
    fn a_selection_read_never_upgrades_or_downgrades_a_settled_outcome() {
        for pressed in [
            DeliveryOutcome::NotDelivered,
            DeliveryOutcome::SatisfiedNoDelivery,
            DeliveryOutcome::DeliveredVerified,
        ] {
            for selected in [Some(true), Some(false), None] {
                assert_eq!(outcome_from_selection(pressed, selected), pressed);
            }
        }
    }
}
