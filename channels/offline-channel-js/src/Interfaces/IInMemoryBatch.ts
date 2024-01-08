import { ITelemetryItem } from "@microsoft/applicationinsights-core-js";
import { eEventPersistenceValue } from "./IOfflineProvider";

export interface IInMemoryBatch {
    /**
     * Enqueue the payload
     */
    addEvent: (evt: IPostTransmissionTelemetryItem | ITelemetryItem) => void;
    /**
     * Returns the number of elements in the buffer
     */
    count: () => number;

    /**
     * Returns items stored in the buffer
     */
    getItems: () => IPostTransmissionTelemetryItem[] | ITelemetryItem[];
    
    /**
     * Split this batch into 2 with any events > fromEvent returned in the new batch and all other
     * events are kept in the current batch.
     * @param fromEvt The first event to remove from the current batch.
     * @param numEvts The number of events to be removed from the current batch and returned in the new one. Defaults to all trailing events
     */
    split: (fromEvt: number, numEvts?: number) => IInMemoryBatch;
     /**
     * create current buffer to a new endpoint with current logger
     * @param endpoint new endpoint
     * @param evts new events to be added
     * @param evtsLimitInMem new evtsLimitInMem
     */
    createNew(endpoint: string, evts?: IPostTransmissionTelemetryItem[] | ITelemetryItem[], evtsLimitInMem?: number): IInMemoryBatch;

}

export interface IPostTransmissionTelemetryItem extends ITelemetryItem {

    persistence?: eEventPersistenceValue
}
