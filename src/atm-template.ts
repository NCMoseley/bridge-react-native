import crypto from 'node:crypto';
import type { RangeConfiguration } from './types.js';

// Renders an NT8 ATM strategy template XML for a break-even-enabled range.
// Field mapping (ticks = cents/100):
//   <Template>                     <- range name (must match atm_strategy exactly)
//   <AutoBreakEvenProfitTrigger>   <- breakEvenTriggerTicksCents
//   <AutoBreakEvenPlus>            <- breakEvenOffsetTicksCents (0 = move to entry)
//   <StopLoss>/<Target>            <- the range's SL/TP ticks as sane defaults;
//                                     the wire's explicit prices still ride along.
//   <AtmSelector>                  <- fresh GUID per render
// Output files belong in `Documents\NinjaTrader 8\templates\AtmStrategy\`.

const REFERENCE_XML = `﻿<?xml version="1.0" encoding="utf-8"?>
<NinjaTrader>
  <AtmStrategy xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <IsVisible>true</IsVisible>
    <calculate2>OnBarClose</calculate2>
    <AreLinesConfigurable>true</AreLinesConfigurable>
    <ArePlotsConfigurable>true</ArePlotsConfigurable>
    <BarsToLoad>0</BarsToLoad>
    <Calculate>OnBarClose</Calculate>
    <Displacement>0</Displacement>
    <DisplayInDataBox>true</DisplayInDataBox>
    <From>2099-12-01T00:00:00</From>
    <IsAutoScale>true</IsAutoScale>
    <Lines />
    <MaximumBarsLookBack>TwoHundredFiftySix</MaximumBarsLookBack>
    <Name>AtmStrategy</Name>
    <Panel>0</Panel>
    <Plots />
    <ScaleJustification>Right</ScaleJustification>
    <ShowTransparentPlotsInDataBox>false</ShowTransparentPlotsInDataBox>
    <To>1800-01-01T00:00:00</To>
    <IsDataSeriesRequired>false</IsDataSeriesRequired>
    <IsOverlay>false</IsOverlay>
    <SelectedValueSeries>0</SelectedValueSeries>
    <Gtd>1800-01-01T00:00:00</Gtd>
    <Template>Test Range</Template>
    <TimeInForce>Day</TimeInForce>
    <BarsRequiredToTrade>0</BarsRequiredToTrade>
    <Category>Atm</Category>
    <ConnectionLossHandling>KeepRunning</ConnectionLossHandling>
    <DaysToLoad>1</DaysToLoad>
    <DefaultQuantity>1</DefaultQuantity>
    <DisconnectDelaySeconds>0</DisconnectDelaySeconds>
    <EntriesPerDirection>1</EntriesPerDirection>
    <EntryHandling>AllEntries</EntryHandling>
    <ExitOnSessionCloseSeconds>0</ExitOnSessionCloseSeconds>
    <IncludeCommission>false</IncludeCommission>
    <IsAggregated>false</IsAggregated>
    <IsExitOnSessionCloseStrategy>false</IsExitOnSessionCloseStrategy>
    <IsFillLimitOnTouch>false</IsFillLimitOnTouch>
    <IsOptimizeDataSeries>false</IsOptimizeDataSeries>
    <IsStableSession>false</IsStableSession>
    <IsTickReplay>false</IsTickReplay>
    <IsTradingHoursBreakLineVisible>false</IsTradingHoursBreakLineVisible>
    <IsWaitUntilFlat>false</IsWaitUntilFlat>
    <NumberRestartAttempts>0</NumberRestartAttempts>
    <OptimizationPeriod>10</OptimizationPeriod>
    <OrderFillResolution>High</OrderFillResolution>
    <OrderFillResolutionType>Tick</OrderFillResolutionType>
    <OrderFillResolutionValue>1</OrderFillResolutionValue>
    <RestartsWithinMinutes>0</RestartsWithinMinutes>
    <SetOrderQuantity>Strategy</SetOrderQuantity>
    <Slippage>0</Slippage>
    <StartBehavior>AdoptAccountPosition</StartBehavior>
    <StopTargetHandling>PerEntryExecution</StopTargetHandling>
    <SupportsOptimizationGraph>false</SupportsOptimizationGraph>
    <TestPeriod>28</TestPeriod>
    <TradingHoursSerializable />
    <Brackets>
      <Bracket>
        <Quantity>1</Quantity>
        <StopLoss>1</StopLoss>
        <StopStrategy>
          <AutoBreakEvenPlus>0</AutoBreakEvenPlus>
          <AutoBreakEvenProfitTrigger>120</AutoBreakEvenProfitTrigger>
          <AutoTrailSteps />
          <IsSimStopEnabled>false</IsSimStopEnabled>
          <VolumeTrigger>0</VolumeTrigger>
          <Template>BE 120</Template>
        </StopStrategy>
        <Target>1</Target>
      </Bracket>
    </Brackets>
    <CalculationMode>Ticks</CalculationMode>
    <ChaseLimit>0</ChaseLimit>
    <EntryQuantity>1</EntryQuantity>
    <InitialTickSize>0</InitialTickSize>
    <IsChase>false</IsChase>
    <IsChaseIfTouched>false</IsChaseIfTouched>
    <IsTargetChase>false</IsTargetChase>
    <ReverseAtStop>false</ReverseAtStop>
    <ReverseAtTarget>false</ReverseAtTarget>
    <UseMitForProfit>false</UseMitForProfit>
    <UseStopLimitForStopLossOrders>false</UseStopLimitForStopLossOrders>
    <AtmSelector>1d475d1a7000469eaafd0b87c8da8ae1</AtmSelector>
    <OnBehalfOf />
    <ReverseAtStopStrategyId>-1</ReverseAtStopStrategyId>
    <ReverseAtTargetStrategyId>-1</ReverseAtTargetStrategyId>
    <ShadowStrategyStrategyId>-1</ShadowStrategyStrategyId>
    <ShadowTemplate />
  </AtmStrategy>
</NinjaTrader>
`;

const xmlEscape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function renderNt8AtmTemplateXml(config: RangeConfiguration): string {
  const triggerTicks = Math.round(config.breakEvenTriggerTicksCents / 100);
  const offsetTicks = Math.round(config.breakEvenOffsetTicksCents / 100);
  const slTicks = config.stopLossStyle === 'ticks' ? Math.round(config.stopLossTicksCents / 100) : 200;
  const tpTicks = config.takeProfitStyle === 'ticks' ? Math.round(config.takeProfitTicksCents / 100) : 200;
  const guid = crypto.randomUUID().replace(/-/g, '');

  // The file has two <Template> elements — the first is the strategy name
  // (matched by atm_strategy on the wire), the second labels the embedded
  // StopStrategy block. Positional replace keeps them distinct regardless of
  // the reference file's own names.
  let templateIndex = 0;
  let xml = REFERENCE_XML
    .replace(/<Template>[^<]*<\/Template>/g, () =>
      templateIndex++ === 0
        ? `<Template>${xmlEscape(config.rangeName)}</Template>`
        : `<Template>BE ${triggerTicks}+${offsetTicks}</Template>`)
    .replace(/<AutoBreakEvenProfitTrigger>-?\d+<\/AutoBreakEvenProfitTrigger>/, `<AutoBreakEvenProfitTrigger>${triggerTicks}</AutoBreakEvenProfitTrigger>`)
    .replace(/<AutoBreakEvenPlus>-?\d+<\/AutoBreakEvenPlus>/, `<AutoBreakEvenPlus>${offsetTicks}</AutoBreakEvenPlus>`)
    .replace(/<StopLoss>-?\d+<\/StopLoss>/, `<StopLoss>${slTicks}</StopLoss>`)
    .replace(/<Target>-?\d+<\/Target>/, `<Target>${tpTicks}</Target>`)
    .replace(/<AtmSelector>[0-9a-f]*<\/AtmSelector>/i, `<AtmSelector>${guid}</AtmSelector>`);

  if (!xml.startsWith('﻿')) xml = `﻿${xml}`; // NT8 templates are saved UTF-8 BOM
  return xml;
}

export function atmTemplateFileName(rangeName: string): string {
  return `${rangeName.replace(/[\\/:*?"<>|]/g, '_')}.xml`;
}
